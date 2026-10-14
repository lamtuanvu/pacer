/** Plain-text columns with a shared width per column and no trailing padding. */
export function table(headers:string[], rows:string[][]):string {
  const widths=headers.map((header,i)=>Math.max(header.length,...rows.map(row=>row[i].length)));
  return [headers,...rows].map(row=>row.map((cell,i)=>i===row.length-1 ? cell : cell.padEnd(widths[i])).join("  ")).join("\n");
}
