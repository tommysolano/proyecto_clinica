#!/usr/bin/env node
'use strict';

/**
 * Copia local, comprimida y restaurable de las colecciones de una clínica antes
 * de reproyectar Contífico. No modifica MongoDB.
 *
 *   node scripts/backupContificoProjection.js --clinic-name=Central
 */

require('dotenv').config();
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const mongoose = require('mongoose');
// El EJSON del driver: el paquete `bson` suelto puede ser otra versión e
// incompatible con los ObjectId que entrega mongoose.
const { EJSON } = require('mongoose').mongo.BSON;
const Clinic = require('../models/Clinic');

const collections = [
  'contificorecords', 'contificomigrationruns', 'chartofaccounts', 'costcenters',
  'inventorycategories', 'warehouses', 'bankaccounts', 'suppliers', 'patients',
  'products', 'sales', 'invoices', 'purchaseinvoices', 'inventorymovements',
  'banktransactions', 'journalentries', 'accountbalances', 'receivables', 'payables',
  'payments', 'employees', 'payrolls', 'inventorylayers', 'creditdebitnotes',
];

function args(argv) {
  const values = {};
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const at = arg.indexOf('=');
    if (at > 0) values[arg.slice(2, at)] = arg.slice(at + 1);
  }
  return { clinicId: values.clinic || null, clinicName: values['clinic-name'] || 'Central' };
}

function safeName(value) { return String(value).replace(/[^a-z0-9._-]+/gi, '_'); }
function writeChunk(stream, chunk) {
  if (stream.write(chunk)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const done = () => { stream.removeListener('error', failed); resolve(); };
    const failed = (error) => { stream.removeListener('drain', done); reject(error); };
    stream.once('drain', done);
    stream.once('error', failed);
  });
}

async function dumpCollection(db, name, clinicId, directory) {
  const filename = `${safeName(name)}.ndjson.gz`;
  const target = path.join(directory, filename);
  const output = fs.createWriteStream(target, { flags: 'wx' });
  const gzip = zlib.createGzip({ level: 9 });
  gzip.pipe(output);
  const hash = crypto.createHash('sha256');
  let count = 0;
  try {
    const cursor = db.collection(name).find({ clinic: clinicId });
    for await (const row of cursor) {
      const line = `${EJSON.stringify(row, { relaxed: false })}\n`;
      hash.update(line);
      await writeChunk(gzip, line);
      count += 1;
    }
    await new Promise((resolve, reject) => {
      gzip.once('error', reject);
      output.once('error', reject);
      output.once('finish', resolve);
      gzip.end();
    });
  } catch (error) {
    gzip.destroy(); output.destroy();
    throw error;
  }
  return { collection: name, file: filename, count, sha256: hash.digest('hex') };
}

async function main() {
  if (!process.env.MONGODB_URI) throw new Error('Falta MONGODB_URI');
  const options = args(process.argv.slice(2));
  await mongoose.connect(process.env.MONGODB_URI);
  const clinic = options.clinicId
    ? await Clinic.findById(options.clinicId).lean()
    : await Clinic.findOne({ name: new RegExp(`^${String(options.clinicName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }).lean();
  if (!clinic) throw new Error('Clínica destino no encontrada');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const directory = path.resolve(__dirname, '..', 'storage', 'contifico-backups', `${safeName(clinic.name)}-${stamp}`);
  fs.mkdirSync(directory, { recursive: true });
  const manifest = { clinic: { id: String(clinic._id), name: clinic.name }, createdAt: new Date().toISOString(), collections: [] };
  for (const name of collections) {
    const result = await dumpCollection(mongoose.connection.db, name, clinic._id, directory);
    manifest.collections.push(result);
    console.log(`${name}: ${result.count}`);
  }
  fs.writeFileSync(path.join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  console.log(JSON.stringify({ backup: directory, collections: manifest.collections.length }, null, 2));
}

if (require.main === module) main()
  .catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect().catch(() => {}));

module.exports = { args, collections };
