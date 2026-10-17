// SSH tunnels (SQLYog-style): the database driver connects to a local port on 127.0.0.1,
// and every socket accepted there is forwarded through one SSH session to dbHost:dbPort
// as seen from the SSH server.
import net from 'node:net';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { Client } from 'ssh2';
import { t } from './i18n.js';

const expandHome = (p) => (p && p.startsWith('~') ? homedir() + p.slice(1) : p);

function sshConfig(ssh) {
  const cfg = {
    host: ssh.host,
    port: Number(ssh.port) || 22,
    username: ssh.user,
    readyTimeout: 15000,
    keepaliveInterval: 15000,
    keepaliveCountMax: 3,
  };
  const auth = ssh.auth || 'password';
  if (auth === 'password') {
    cfg.password = ssh.password || '';
    cfg.tryKeyboard = true;
  } else if (auth === 'key') {
    const file = expandHome(ssh.keyFile || '~/.ssh/id_ed25519');
    try {
      cfg.privateKey = readFileSync(file);
    } catch (e) {
      throw new Error(t('Cannot read SSH private key {file}: {error}', { file, error: e.code || e.message }));
    }
    if (ssh.passphrase) cfg.passphrase = ssh.passphrase;
  } else if (auth === 'agent') {
    if (!process.env.SSH_AUTH_SOCK) throw new Error(t('SSH agent not available (SSH_AUTH_SOCK is not set)'));
    cfg.agent = process.env.SSH_AUTH_SOCK;
  }
  return cfg;
}

/**
 * Open a tunnel. Resolves to { port, close(), onClose(cb) } once the SSH session is ready.
 * dstHost is resolved by the SSH server, so "127.0.0.1" means the database on the SSH host itself.
 */
export function openTunnel(ssh, dstHost, dstPort) {
  if (!ssh?.host) return Promise.reject(new Error(t('SSH host is required')));
  if (!ssh?.user) return Promise.reject(new Error(t('SSH user is required')));
  const cfg = sshConfig(ssh);

  return new Promise((resolve, reject) => {
    const client = new Client();
    const sockets = new Set();
    const closeHandlers = [];
    let server = null;
    let closed = false;
    let ready = false;

    const close = () => {
      if (closed) return;
      closed = true;
      for (const s of sockets) s.destroy();
      server?.close();
      client.end();
      for (const cb of closeHandlers) cb();
    };

    client.on('keyboard-interactive', (_name, _instr, _lang, prompts, finish) => {
      finish(prompts.map(() => cfg.password || ''));
    });

    client.on('error', (err) => {
      const msg = /authentication/i.test(err.message)
        ? t('SSH authentication failed for {user}@{host}', { user: ssh.user, host: ssh.host })
        : `SSH: ${err.message}`;
      if (!ready) reject(new Error(msg));
      close();
    });
    client.on('close', close);

    client.on('ready', () => {
      ready = true;
      server = net.createServer((sock) => {
        sockets.add(sock);
        sock.on('close', () => sockets.delete(sock));
        sock.on('error', () => {});
        client.forwardOut('127.0.0.1', 0, dstHost, Number(dstPort), (err, stream) => {
          if (err) {
            sock.destroy();
            return;
          }
          stream.on('error', () => sock.destroy());
          sock.pipe(stream).pipe(sock);
        });
      });
      server.on('error', (e) => {
        reject(e);
        close();
      });
      server.listen(0, '127.0.0.1', () => {
        resolve({ port: server.address().port, close, onClose: (cb) => closeHandlers.push(cb) });
      });
    });

    client.connect(cfg);
  });
}
