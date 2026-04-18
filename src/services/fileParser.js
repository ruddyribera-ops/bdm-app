// File parsing service for BDM App
// Handles PDF, DOCX, and text file extraction

import mammoth from "mammoth/mammoth.browser";

// Singleton PDF.js instance
let _pdfjs = null;

/**
 * Get or initialize PDF.js library
 */
export async function getPdfJs() {
  if (_pdfjs) return _pdfjs;
  return new Promise(resolve => {
    if (window.pdfjsLib) { _pdfjs = window.pdfjsLib; resolve(_pdfjs); return; }
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
    s.onload = () => {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc =
        "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
      _pdfjs = window.pdfjsLib;
      resolve(_pdfjs);
    };
    document.head.appendChild(s);
  });
}

/**
 * Convert ArrayBuffer to base64 string
 */
export function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/**
 * Perform OCR on scanned PDF pages using AI vision
 * @param {Object} pdf - PDF.js document object
 * @param {string} name - File name for logging
 * @param {Function} callMotor - AI callback function
 * @param {Function} logFn - Logging function
 */
export async function ocrPdfWithVision(pdf, name, callMotor, logFn) {
  const total = pdf.numPages;
  const BATCH = 6;
  let allText = "";
  
  for (let start = 1; start <= total; start += BATCH) {
    const end = Math.min(start + BATCH - 1, total);
    if (logFn) logFn(`  → OCR páginas ${start}–${end}/${total}...`);
    
    const blocks = [];
    for (let p = start; p <= end; p++) {
      const page = await pdf.getPage(p);
      const vp = page.getViewport({ scale: 0.7 });
      const canvas = document.createElement("canvas");
      canvas.width = vp.width; canvas.height = vp.height;
      await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
      blocks.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: canvas.toDataURL("image/jpeg", 0.8).split(",")[1] } });
    }
    
    blocks.push({ type: "text", text: `Transcribe todo el texto visible en estas ${end - start + 1} páginas. Incluye tablas, números, nombres y cifras. Solo el texto, sin comentarios.` });
    
    const chunk = await callMotor("Eres un extractor OCR. Transcribe fielmente todo el contenido visible.", blocks, 4000);
    allText += chunk + "\n\n";
    
    if (end < total) await new Promise(r => setTimeout(r, 15000));
  }
  
  return allText.trim();
}

/**
 * Read and parse a file (PDF, DOCX, or text)
 * @param {File} file - The file to read
 * @param {Function} callMotor - AI callback for OCR (optional)
 * @param {Function} logFn - Logging function (optional)
 * @returns {Object} Parsed file data
 */
export async function readFile(file, callMotor, logFn) {
  const ext = file.name.split(".").pop().toLowerCase();
  
  if (ext === "pdf") {
    const arrayBuf = await file.arrayBuffer();
    const b64 = arrayBufferToBase64(arrayBuf);
    
    try {
      const lib = await getPdfJs();
      const pdf = await lib.getDocument({ data: arrayBuf }).promise;
      let text = "";
      
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        text += content.items.map(it => it.str).join(" ") + "\n";
      }
      
      const avgCharsPerPage = text.trim().length / pdf.numPages;
      if (avgCharsPerPage < 80 && logFn) {
        logFn(`  → PDF escaneado detectado — aplicando OCR visual (${pdf.numPages} pág.)...`);
        
        // Only use OCR if callMotor is provided
        if (callMotor) {
          const ocrText = await ocrPdfWithVision(pdf, file.name, callMotor, logFn);
          return { type: "pdf", b64, text: ocrText, name: file.name, pages: pdf.numPages, ocr: true };
        }
      }
      
      return { type: "pdf", b64, text: text.trim(), name: file.name, pages: pdf.numPages };
    } catch {
      return { type: "pdf", b64, text: "", name: file.name, pages: "?" };
    }
  }
  
  if (ext === "docx") {
    const buf = await file.arrayBuffer();
    const { value } = await mammoth.extractRawText({ arrayBuffer: buf });
    return { type: "docx", text: value.trim(), name: file.name };
  }
  
  // Plain text or other formats
  const text = await file.text();
  return { type: "text", text: text.trim(), name: file.name };
}

/**
 * Format file size in human-readable format
 */
export function formatFileSize(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}
