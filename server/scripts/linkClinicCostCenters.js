#!/usr/bin/env node
'use strict';

// Compatibilidad con el comando anterior. La configuración actual conserva
// centros y bodegas de Contífico en la sucursal que les corresponde.
require('dotenv').config();
const mongoose = require('mongoose');
const { configure } = require('./configureCostCenterBranches');

mongoose.connect(process.env.MONGODB_URI)
  .then(() => configure({ commit: process.argv.includes('--commit') }))
  .then((result) => console.log(JSON.stringify(result)))
  .catch((error) => { console.error(error.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect().catch(() => {}));
