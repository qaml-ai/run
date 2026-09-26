import { createDeflate } from "node:zlib";

/** A 2×3 PNG's signature and header: enough for sniffing and inspection, which never decode pixels. */
export const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), Buffer.from("IHDR"), Buffer.from([0, 0, 0, 2, 0, 0, 0, 3, 8, 2, 0, 0, 0])]);

/** A minimal PDF with one line of text per page. */
export function pdfBytes(pages: string[]) {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Kids [${pages.map((_, index) => `${3 + index * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`];
  const font = 3 + pages.length * 2;
  pages.forEach((text, index) => {
    const content = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${4 + index * 2} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  });
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  let out = "%PDF-1.4\n";
  const offsets = objects.map((object, index) => { const at = out.length; out += `${index + 1} 0 obj\n${object}\nendobj\n`; return at; });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}


/** A 400 KB PDF whose one page's content inflates to 400 MB: parsing it needs far more memory than it looks. */
export async function bombPdf() {
  const deflate = createDeflate({ level: 9 });
  const compressed: Buffer[] = [];
  deflate.on("data", chunk => compressed.push(chunk));
  const zeros = Buffer.alloc(1024 * 1024, 0x20);
  for (let i = 0; i < 400; i++) if (!deflate.write(zeros)) await new Promise(resolve => deflate.once("drain", resolve));
  deflate.end();
  await new Promise(resolve => deflate.once("end", resolve));
  const stream = Buffer.concat(compressed);
  const head = "%PDF-1.4\n";
  const objects = [Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"), Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"), Buffer.from("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>"),
    Buffer.concat([Buffer.from(`<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`), stream, Buffer.from("\nendstream")])];
  const parts: Buffer[] = [Buffer.from(head)];
  let length = head.length;
  const offsets = objects.map((object, index) => {
    const at = length;
    const part = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), object, Buffer.from("\nendobj\n")]);
    parts.push(part);
    length += part.length;
    return at;
  });
  parts.push(Buffer.from(`xref\n0 5\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`));
  return Buffer.concat(parts);
}
