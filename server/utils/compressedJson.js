'use strict';

const zlib = require('zlib');

function asBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (Buffer.isBuffer(value?.buffer)) {
    const length = Number.isInteger(value.position) && value.position > 0
      ? value.position
      : value.buffer.length;
    return value.buffer.subarray(0, length);
  }
  if (typeof value?.value === 'function') return Buffer.from(value.value(true));
  return Buffer.from(value);
}

function decodeCompressedJson(value) {
  return JSON.parse(zlib.gunzipSync(asBuffer(value)).toString('utf8'));
}

module.exports = { asBuffer, decodeCompressedJson };
