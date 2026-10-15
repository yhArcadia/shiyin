import { zipSync } from '../vendor/fflate/browser.js';
self.onmessage = ({ data }) => {
  try {
    const files = Object.create(null);
    for (const file of data.files) files[file.name] = file.bytes;
    const bytes = zipSync(files, { level: 0 });
    self.postMessage({ bytes }, [bytes.buffer]);
  } catch (error) { self.postMessage({ error: error.message }); }
};
