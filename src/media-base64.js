// A repeated four-character regex group over multi-megabyte media can exhaust
// V8's regexp stack. Validate linear character/padding scans and length instead.
function isMediaBase64(value) {
  return typeof value === 'string' && value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value);
}
module.exports = { isMediaBase64 };
