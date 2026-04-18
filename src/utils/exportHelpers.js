// Export helpers for BDM App
// Converts markdown to Word (.doc) and plain text (.md)

/**
 * Convert markdown to Word-compatible HTML
 */
export function toWordHtml(md, title) {
  let h = md
    .replace(/^# (.+)$/gm, '<h1 style="font-family:Arial;font-size:16pt;font-weight:bold;border-bottom:1pt solid #000;padding-bottom:4pt;margin-top:20pt;">$1</h1>')
    .replace(/^## (.+)$/gm, '<h2 style="font-family:Arial;font-size:14pt;font-weight:bold;margin-top:14pt;">$1</h2>')
    .replace(/^### (.+)$/gm, '<h3 style="font-family:Arial;font-size:12pt;font-weight:bold;margin-top:10pt;">$3</h3>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/^---$/gm, '<hr style="border:0.5pt solid #000;margin:8pt 0;"/>')
    .replace(/^\| (.+) \|$/gm, row => {
      const cells = row.split('|').slice(1,-1).map(c=>c.trim());
      if (cells.every(c=>c.match(/^[-:]+$/))) return '';
      return '<tr>' + cells.map(c=>`<td style="border:1pt solid #000;padding:5pt 8pt;font-family:Arial;font-size:13px;">${c}</td>`).join('') + '</tr>';
    })
    .replace(/(<tr>.*?<\/tr>\n?)+/gs, m=>`<table style="border-collapse:collapse;width:100%;margin:8pt 0;">${m}</table>`)
    .replace(/^[-*] (.+)$/gm, '<li style="font-family:Arial;font-size:13px;margin-bottom:3pt;">$1</li>')
    .replace(/(<li[^>]*>.*?<\/li>\n?)+/gs, m=>`<ul style="margin:4pt 0 4pt 18pt;">${m}</ul>`)
    .replace(/^(?!<[hult]|<\/|$)(.+)$/gm, '<p style="font-family:Arial;font-size:13px;line-height:1.6;margin:4pt 0;">$1</p>');
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${title}</title></head><body style="font-family:Arial;font-size:13px;margin:2.5cm 2cm;">
<div style="border-bottom:2pt solid #000;padding-bottom:10pt;margin-bottom:20pt;">
<p style="font-size:18pt;font-weight:bold;margin:0;">Bosques del Mundo Bolivia</p>
<p style="font-size:11pt;color:#333;margin:4pt 0 0;">${title}</p>
</div>${h}</body></html>`;
}

/**
 * Download content as Word document
 */
export function dlWord(c, n) {
  if (!c) return;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([toWordHtml(c, n)], {type: "application/msword"}));
  a.download = n + ".doc";
  a.click();
}

/**
 * Download content as Markdown file
 */
export function dlMd(c, n) {
  if (!c) return;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([c], {type: "text/plain;charset=utf-8"}));
  a.download = n + ".md";
  a.click();
}
