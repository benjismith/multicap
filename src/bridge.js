// @ts-check
/*
 * bridge.js — synchronous messaging between the MAIN world (page hook) and the
 * isolated world (extension side). Loaded by BOTH worlds.
 *
 * The two worlds share the DOM, so we use CustomEvents on `document`. Payloads
 * are always JSON *strings* (no reliance on cross-world object access), and
 * dispatchEvent is synchronous, so call() has its answer before it returns.
 *
 * Event names:  multicap:<destination>:call | :reply | :event
 * Uses the pristine JSON functions captured by util.js (page-hook.js patches JSON later).
 */
// `var`: shared with the entry file that build.js concatenates after this one.
var MC_BRIDGE = (() => {
  const NS = 'multicap:';

  /**
   * @param {'page' | 'ext'} me
   */
  function create(me) {
    const other = me === 'page' ? 'ext' : 'page';
    const enc = MC_UTIL.jsonStringify;
    const dec = MC_UTIL.jsonParse;
    /** @type {Map<string, (arg: any) => any>} */
    const handlers = new Map();
    /** @type {Map<string, Array<(payload: any) => void>>} */
    const listeners = new Map();
    /** @type {Map<number, {id: number, ok: boolean, value: any}>} */
    const replies = new Map();
    let seq = 0;

    /** @param {Event} e */
    const decode = (e) => {
      const d = /** @type {CustomEvent} */ (e).detail;
      if (typeof d !== 'string') return null;
      try { return dec(d); } catch { return null; }
    };
    /** @param {string} name @param {any} payload */
    const send = (name, payload) => document.dispatchEvent(new CustomEvent(NS + other + ':' + name, { detail: enc(payload) }));

    document.addEventListener(NS + me + ':call', (e) => {
      const msg = decode(e);
      if (!msg) return;
      let reply;
      const fn = handlers.get(msg.name);
      if (!fn) reply = { id: msg.id, ok: false, value: `no handler '${msg.name}' on ${me}` };
      else {
        try { reply = { id: msg.id, ok: true, value: fn(msg.arg) }; }
        catch (err) { reply = { id: msg.id, ok: false, value: String((err && /** @type {any} */ (err).stack) || err) }; }
      }
      send('reply', reply);
    });

    document.addEventListener(NS + me + ':reply', (e) => {
      const msg = decode(e);
      if (msg) replies.set(msg.id, msg);
    });

    document.addEventListener(NS + me + ':event', (e) => {
      const msg = decode(e);
      if (!msg) return;
      for (const fn of listeners.get(msg.name) ?? []) {
        try { fn(msg.payload); } catch (err) { MC_UTIL.warn(`bridge listener '${msg.name}' threw:`, err); }
      }
    });

    return {
      /** Register a synchronous request handler. @param {string} name @param {(arg: any) => any} fn */
      handle(name, fn) { handlers.set(name, fn); },
      /**
       * Synchronous request to the other world. Throws if it isn't loaded or its handler failed.
       * @param {string} name @param {any} [arg]
       */
      call(name, arg) {
        const id = ++seq;
        send('call', { id, name, arg });
        const r = replies.get(id);
        replies.delete(id);
        if (!r) throw new Error(`bridge: no reply from '${other}' for '${name}' (is that side loaded?)`);
        if (!r.ok) throw new Error(`bridge: ${other}.${name} failed: ${r.value}`);
        return r.value;
      },
      /** Fire-and-forget notification. @param {string} name @param {any} [payload] */
      emit(name, payload) { send('event', { name, payload }); },
      /** @param {string} name @param {(payload: any) => void} fn */
      on(name, fn) { (listeners.get(name) ?? listeners.set(name, []).get(name))?.push(fn); },
    };
  }

  return { create };
})();
