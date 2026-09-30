const SEGMENT = 0x18538067;
const INFO = 0x1549a966;
const TIMECODE_SCALE = 0x2ad7b1;
const DURATION = 0x4489;

function integer(buffer, offset, width) {
  let value = 0n;
  for (let index = 0; index < width; index += 1) value = (value << 8n) | BigInt(buffer[offset + index]);
  return value;
}

function elementAt(buffer, offset, limit) {
  const start = offset;
  if (offset >= limit || !buffer[offset]) throw new Error('Recorded WebM has an invalid EBML element.');
  let idWidth = 1;
  while (idWidth <= 4 && !(buffer[offset] & (0x80 >> (idWidth - 1)))) idWidth += 1;
  if (idWidth > 4 || offset + idWidth >= limit) throw new Error('Recorded WebM has an invalid EBML identifier.');
  const id = Number(integer(buffer, offset, idWidth));
  offset += idWidth;
  let sizeWidth = 1;
  while (sizeWidth <= 8 && !(buffer[offset] & (0x80 >> (sizeWidth - 1)))) sizeWidth += 1;
  if (sizeWidth > 8 || offset + sizeWidth > limit) throw new Error('Recorded WebM has an invalid EBML size.');
  const size = integer(buffer, offset, sizeWidth) & ((1n << BigInt(sizeWidth * 7)) - 1n);
  const unknown = size === (1n << BigInt(sizeWidth * 7)) - 1n;
  const dataStart = offset + sizeWidth;
  if (!unknown && size > BigInt(limit - dataStart)) throw new Error('Recorded WebM is truncated.');
  return { id, start, sizeOffset: offset, sizeWidth, dataStart, end: unknown ? limit : dataStart + Number(size), unknown };
}

function elements(buffer, start, end) {
  const result = [];
  for (let offset = start; offset < end;) {
    const element = elementAt(buffer, offset, end);
    result.push(element);
    offset = element.end;
  }
  return result;
}

function sizeBytes(value, preferredWidth) {
  let width = preferredWidth;
  while (width < 8 && BigInt(value) >= (1n << BigInt(width * 7)) - 1n) width += 1;
  if (BigInt(value) >= (1n << BigInt(width * 7)) - 1n) throw new Error('Recorded WebM size cannot be encoded.');
  let encoded = BigInt(value) | (1n << BigInt(width * 7));
  const result = Buffer.alloc(width);
  for (let index = width - 1; index >= 0; index -= 1) { result[index] = Number(encoded & 255n); encoded >>= 8n; }
  return result;
}

// MediaRecorder emits a streaming WebM without Duration. Add it before saving so reopened clips report finite metadata.
function repairWebmDuration(buffer, durationSeconds) {
  if (!Buffer.isBuffer(buffer) || !Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error('Recorded WebM duration is invalid.');
  const segment = elements(buffer, 0, buffer.length).find((element) => element.id === SEGMENT);
  if (!segment) throw new Error('Recorded WebM is missing its Segment.');
  const children = elements(buffer, segment.dataStart, segment.end);
  const info = children.find((element) => element.id === INFO);
  if (!info || info.unknown) throw new Error('Recorded WebM is missing bounded Info metadata.');
  const infoChildren = elements(buffer, info.dataStart, info.end);
  const scaleElement = infoChildren.find((element) => element.id === TIMECODE_SCALE);
  const scaleWidth = scaleElement ? scaleElement.end - scaleElement.dataStart : 0;
  if (scaleElement && (scaleWidth < 1 || scaleWidth > 8)) throw new Error('Recorded WebM TimecodeScale is invalid.');
  const scale = scaleElement ? Number(integer(buffer, scaleElement.dataStart, scaleWidth)) : 1_000_000;
  if (!Number.isSafeInteger(scale) || scale <= 0) throw new Error('Recorded WebM TimecodeScale is invalid.');
  const units = durationSeconds * 1_000_000_000 / scale;
  const existing = infoChildren.find((element) => element.id === DURATION);
  if (existing) {
    const result = Buffer.from(buffer);
    const width = existing.end - existing.dataStart;
    if (width === 8) result.writeDoubleBE(units, existing.dataStart);
    else if (width === 4) result.writeFloatBE(units, existing.dataStart);
    else throw new Error('Recorded WebM Duration has an unsupported size.');
    return result;
  }
  // The streaming output has no seek index. Indexed files need their offsets rewritten when Info grows.
  if (children.some((element) => [0x114d9b74, 0x1c53bb6b].includes(element.id))) throw new Error('Recorded WebM unexpectedly contains a seek index; Duration cannot be safely added.');
  const duration = Buffer.alloc(11);
  duration.set([0x44, 0x89, 0x88]);
  duration.writeDoubleBE(units, 3);
  const infoPayload = Buffer.concat([buffer.subarray(info.dataStart, info.end), duration]);
  const infoBytes = Buffer.concat([buffer.subarray(info.start, info.sizeOffset), sizeBytes(infoPayload.length, info.sizeWidth), infoPayload]);
  const segmentPayload = Buffer.concat([buffer.subarray(segment.dataStart, info.start), infoBytes, buffer.subarray(info.end, segment.end)]);
  const segmentSize = segment.unknown ? buffer.subarray(segment.sizeOffset, segment.dataStart) : sizeBytes(segmentPayload.length, segment.sizeWidth);
  return Buffer.concat([buffer.subarray(0, segment.sizeOffset), segmentSize, segmentPayload, buffer.subarray(segment.end)]);
}

module.exports = { repairWebmDuration };
