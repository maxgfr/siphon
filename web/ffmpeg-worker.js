/**
 * ffmpeg.wasm, off the main thread.
 *
 * This is deliberately our own worker rather than @ffmpeg/ffmpeg's, for one
 * mechanical reason: that package spawns its worker with a URL relative to its
 * own module, and a page cannot spawn a worker from another origin. Loading
 * the wrapper from a CDN therefore cannot work, and the usual blob-URL escape
 * breaks its ESM worker's relative imports.
 *
 * Driving @ffmpeg/core directly avoids all of it. This file is served from our
 * own origin so `new Worker` is allowed; `importScripts` has no such
 * restriction, so the 32 MB core can still come from a CDN or a copy the user
 * hosts themselves.
 *
 * The single-threaded core is the one used on purpose: the multi-threaded
 * build needs SharedArrayBuffer, which needs COOP/COEP headers, which GitHub
 * Pages cannot send. Slower, but it runs where the app actually lives.
 */

let core = null;

/**
 * Which run the progress callback is currently reporting on.
 *
 * The core takes one progress callback for its whole lifetime, so the run's id
 * has to be stamped on each message — otherwise two queued conversions both
 * drive whichever bar was set up last.
 */
let activeRun = null;

/** Emscripten writes its exit code into `ret`; a non-zero one means ffmpeg failed. */
function run(args) {
  core.setTimeout(-1);
  core.exec(...args);
  return core.ret;
}

self.onmessage = async (event) => {
  const { id, type, payload } = event.data || {};
  const reply = (message, transfer) => self.postMessage({ id, ...message }, transfer || []);

  try {
    if (type === 'load') {
      if (!core) {
        importScripts(payload.coreURL);
        // The core reads the addresses of its own .wasm out of the fragment on
        // this URL — an emscripten quirk, but the documented one. Without it
        // the module tries to decode an empty fragment and fails on atob.
        const locations = btoa(JSON.stringify({ wasmURL: payload.wasmURL, workerURL: payload.workerURL }));
        core = await self.createFFmpegCore({ mainScriptUrlOrBlob: `${payload.coreURL}#${locations}` });
        core.setLogger(({ message }) => self.postMessage({ id: activeRun, type: 'log', message }));
        core.setProgress(({ progress }) => self.postMessage({ id: activeRun, type: 'progress', progress }));
      }
      reply({ type: 'loaded' });
      return;
    }

    if (type === 'run') {
      for (const input of payload.inputs) core.FS.writeFile(input.name, input.data);
      activeRun = id;
      const code = run(payload.args);
      activeRun = null;
      // Free the inputs before reading the output: a 200 MB video and its copy
      // both in wasm memory at once is how this falls over on a phone.
      for (const input of payload.inputs) {
        try {
          core.FS.unlink(input.name);
        } catch {
          /* already gone */
        }
      }
      if (code !== 0) throw new Error(`ffmpeg exited with ${code}`);

      const data = core.FS.readFile(payload.output);
      try {
        core.FS.unlink(payload.output);
      } catch {
        /* already gone */
      }
      reply({ type: 'result', data }, [data.buffer]);
      return;
    }

    throw new Error(`unknown message ${type}`);
  } catch (error) {
    reply({ type: 'error', message: String(error?.message || error) });
  }
};
