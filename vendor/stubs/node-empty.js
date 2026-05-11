// Stub vuoto per moduli Node-only referenziati staticamente da
// @huggingface/transformers ma mai chiamati nel browser.
// Lo importiamo via importmap come destinazione di "fs", "path", "url",
// "sharp", "onnxruntime-node".
export default {};
export const promises = {};
export const readFileSync = () => undefined;
export const existsSync = () => false;
