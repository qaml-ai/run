// Synthetic screenshot corpus. No user/browser image is read or uploaded.
import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const crcTable = Array.from({length:256}, (_,i) => {
  for (let bit=0;bit<8;bit++) i=(i&1)?0xedb88320^(i>>>1):i>>>1;
  return i>>>0;
});
function chunk(type,data) {
  const body=Buffer.concat([Buffer.from(type),data]); let crc=0xffffffff;
  for (const byte of body) crc=crcTable[(crc^byte)&255]^(crc>>>8);
  const size=Buffer.alloc(4),tail=Buffer.alloc(4);
  size.writeUInt32BE(data.length);tail.writeUInt32BE((crc^0xffffffff)>>>0);
  return Buffer.concat([size,body,tail]);
}
export function fixture(index,width=1600,height=1200) {
  if (!Number.isSafeInteger(index)||index<0||index>=100) throw Error('Fixture index must be 0..99');
  const raw=Buffer.alloc((width*3+1)*height);
  // Every nonzero xorshift seed is distinct. Unlike v1, no `seed | 1` pairing.
  let state=(index+1)*0x9e3779b1>>>0;
  for(let y=0;y<height;y++) for(let x=0;x<width;x++) {
    const offset=y*(width*3+1)+1+x*3;
    for(let channel=0;channel<3;channel++) {
      state^=state<<13;state^=state>>>17;state^=state<<5;
      raw[offset+channel]=y<60?40:x<180?70:state&255;
    }
  }
  const header=Buffer.alloc(13);header.writeUInt32BE(width,0);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(raw,{level:6})),chunk('IEND',Buffer.alloc(0))]);
}
export function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
