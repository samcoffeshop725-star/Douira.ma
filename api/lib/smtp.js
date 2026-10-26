/* =====================================================================
   Client SMTP minimal (Node intégré, sans dépendance) : TLS implicite
   (port 465) ou STARTTLS (port 587), AUTH PLAIN / LOGIN, un message texte
   (+ HTML facultatif). Les identifiants viennent des réglages saisis par
   l'administrateur (table settings, mot de passe chiffré), jamais du code.
   ===================================================================== */
'use strict';
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');

function send(cfg, { to, subject, text, html }) {
  return new Promise((resolve, reject) => {
    const port = Number(cfg.port) || 587, secure = cfg.secure === true || port === 465, host = String(cfg.host || '').trim();
    if (!host) return reject(new Error('Serveur SMTP non configuré'));
    let sock, buf = '', done = false, upgraded = secure;
    const timer = setTimeout(() => fail(new Error('SMTP : délai dépassé')), 20000);
    const fail = e => { if (done) return; done = true; clearTimeout(timer); try { sock.destroy(); } catch (x) { /* ignoré */ } reject(e); };
    const finish = () => { if (done) return; done = true; clearTimeout(timer); try { sock.end(); } catch (x) { /* ignoré */ } resolve({ sent: true }); };
    const queue = []; // étapes : [commande à envoyer, codes attendus, action]
    const expect = (cmd, codes, next) => queue.push({ cmd, codes, next });
    let current = null;
    const step = () => { current = queue.shift(); if (!current) return finish(); if (current.cmd !== null) sock.write(current.cmd + '\r\n'); };
    const onLine = reply => {
      const code = Number(reply.slice(0, 3));
      if (!current) return;
      if (!current.codes.includes(code)) return fail(new Error('SMTP : réponse ' + reply.split('\n')[0].slice(0, 120)));
      const n = current.next; current = null; if (n) n(reply); else step();
    };
    const attach = s => {
      sock = s; s.setEncoding('utf8');
      s.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\r\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 2); if (/^\d{3}-/.test(line)) { multi.push(line); continue; } multi.push(line); const full = multi.join('\n'); multi = []; onLine(full); } });
      s.on('error', fail); s.on('close', () => { if (!done) fail(new Error('SMTP : connexion fermée')); });
    };
    let multi = [];
    const ehlo = 'douira.local';
    const plan = () => {
      expect('EHLO ' + ehlo, [250], null);
      if (!upgraded) {
        expect('STARTTLS', [220], () => { const t = tls.connect({ socket: sock, servername: host, rejectUnauthorized: cfg.rejectUnauthorized !== false }, () => { upgraded = true; attach(t); current = null; queue.unshift({ cmd: 'EHLO ' + ehlo, codes: [250], next: null }); step(); }); t.on('error', fail); });
      }
      if (cfg.user) {
        const plain = Buffer.from('\0' + cfg.user + '\0' + (cfg.password || '')).toString('base64');
        expect('AUTH PLAIN ' + plain, [235], null);
      }
      const from = (cfg.from || '').replace(/^.*<([^>]+)>.*$/, '$1').trim() || cfg.user;
      expect(`MAIL FROM:<${from}>`, [250], null);
      expect(`RCPT TO:<${to}>`, [250, 251], null);
      expect('DATA', [354], null);
      const boundary = 'b' + crypto.randomBytes(8).toString('hex');
      const headers = [`From: ${cfg.from || from}`, `To: <${to}>`, `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`, `Date: ${new Date().toUTCString()}`, `Message-ID: <${crypto.randomUUID()}@${host}>`, 'MIME-Version: 1.0'];
      let body;
      if (html) { headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`); body = `--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(text)}\r\n--${boundary}\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(html)}\r\n--${boundary}--`; }
      else { headers.push('Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64'); body = b64(text); }
      expect(headers.join('\r\n') + '\r\n\r\n' + body + '\r\n.', [250], null);
      expect('QUIT', [221], () => finish());
    };
    const b64 = t => Buffer.from(String(t)).toString('base64').replace(/(.{76})/g, '$1\r\n');
    const first = { cmd: null, codes: [220], next: () => { plan(); step(); } };
    queue.push(first);
    const s0 = secure ? tls.connect({ host, port, servername: host, rejectUnauthorized: cfg.rejectUnauthorized !== false }) : net.connect(port, host);
    attach(s0); current = queue.shift();
  });
}
module.exports = { send };
