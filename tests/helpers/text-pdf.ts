/** Deterministic original PDF bytes; no external fixture or copyrighted text. */
export function makeTextPdf(pageCount: number): Buffer {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${Array.from({ length: pageCount }, (_, index) => `${4 + index * 2} 0 R`).join(' ')}] /Count ${pageCount} >>`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
  for (let page = 1; page <= pageCount; page += 1) {
    const contentId = 5 + (page - 1) * 2
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`)
    const lines = [`PAGE_FACT_${page}=verified.`, ...Array.from({ length: 25 }, () => 'This independent report contains ordinary factual evidence.')]
    const stream = `BT /F1 10 Tf 50 740 Td 14 TL ${lines.map((line) => `(${line}) Tj T*`).join('\n')} ET`
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`)
  }
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n` })
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  return Buffer.from(pdf)
}
