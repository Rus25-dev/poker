// Клиент: подключается к хосту по коду, переподключается при обрыве
import { joinRoom } from './net.js';

export class ClientController {
  constructor({ name, token, code }, ui) {
    this.ui = ui; this.name = name; this.token = token; this.code = code.toUpperCase();
    this.myId = null;
    this.closed = false;
    this.retries = 0;
    this._connect();
  }
  isHost() { return false; }

  _connect() {
    this.ui.onStatus({ kind: 'wait', text: this.retries ? `Переподключение… (${this.retries})` : 'Подключаюсь к столу…' });
    this.link = joinRoom(this.code, {
      onOpen: () => {
        this.retries = 0;
        this.link.send({ t: 'join', name: this.name, token: this.token });
        this.ui.onStatus({ kind: 'ok', text: 'За столом' });
      },
      onData: msg => this._onMsg(msg),
      onClose: () => this._lost(),
      onError: err => {
        if (err && err.type === 'peer-unavailable' && this.retries === 0 && !this.myId) { this.ui.onNetError(err); this.closed = true; return; }
        this._lost();
      }
    });
  }

  _lost() {
    if (this.closed) return;
    try { this.link.close(); } catch { /* */ }
    this.retries++;
    if (this.retries > 40) { this.ui.onStatus({ kind: 'err', text: 'Связь с хостом потеряна' }); return; }
    clearTimeout(this._rt);
    this._rt = setTimeout(() => this._connect(), Math.min(5000, 1000 + this.retries * 400));
  }

  _onMsg(msg) {
    if (!msg) return;
    if (msg.t === 'welcome') { this.myId = msg.id; return; }
    if (msg.t === 'state') { this.ui.onState(msg.view); return; }
    if (msg.t === 'kicked') { this.closed = true; this.link.close(); this.ui.onKicked(); return; }
    this.ui.onMessage(msg);
  }

  send(msg) { this.link && this.link.send(msg); }

  destroy() { this.closed = true; clearTimeout(this._rt); try { this.link.close(); } catch { /* */ } }
}
