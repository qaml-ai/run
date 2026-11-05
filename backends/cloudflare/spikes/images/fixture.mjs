// Synthetic screenshot: a title/sidebar and deterministic grayscale sensor noise.
// No image from a user, browser, or repository is uploaded.
import { deflateSync } from 'node:zlib';
const crcTable = Array.from({length:256}, (_,i) => {for(let j=0;j<8;j++) i=(i&1)?0xedb88320^(i>>>1):i>>>1;return i>>>0;});
function chunk(type, data) {
  const name=Buffer.from(type), body=Buffer.concat([name,data]);let crc=0xffffffff;
  for(const byte of body)crc=crcTable[(crc^byte)&255]^(crc>>>8);
  const length=Buffer.alloc(4),tail=Buffer.alloc(4);length.writeUInt32BE(data.length);tail.writeUInt32BE((crc^0xffffffff)>>>0);
  return Buffer.concat([length,body,tail]);
}
export function fixture(seed=1,width=1600,height=1200) {
  // Retained for reproducibility of v1 measurements: seed|1 pairs adjacent
  // seeds, so indices 1..100 produce 51 distinct images, not 100.
  const raw=Buffer.alloc((width*3+1)*height);let state=seed|1;
  for(let y=0;y<height;y++) for(let x=0;x<width;x++) {
    state^=state<<13;state^=state>>>17;state^=state<<5;
    const v=y<60?40:x<180?70:state&255,offset=y*(width*3+1)+1+x*3;
    raw[offset]=v;raw[offset+1]=v;raw[offset+2]=v;
  }
  const head=Buffer.alloc(13);head.writeUInt32BE(width,0);head.writeUInt32BE(height,4);head[8]=8;head[9]=2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',head),chunk('IDAT',deflateSync(raw,{level:6})),chunk('IEND',Buffer.alloc(0))]);
}
