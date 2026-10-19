import net from 'node:net';

/** The host and port a base URL listens on. */
export function urlPort(url: string): { host: string; port: number } {
  const u = new URL(url);
  const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
  return { host: u.hostname.replace(/^\[|\]$/g, ''), port };
}

/** True when something already accepts connections on host:port. */
export function isPortInUse(host: string, port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port, autoSelectFamily: true, timeout: timeoutMs });
    const done = (inUse: boolean) => {
      socket.destroy();
      resolve(inUse);
    };
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/** Throws when a service's port is taken: a leftover process would otherwise answer the health checks. */
export async function assertPortsFree(services: { name: string; url: string }[]): Promise<void> {
  for (const { name, url } of services) {
    const { host, port } = urlPort(url);
    if (await isPortInUse(host, port)) {
      throw new Error(
        `Port ${port} (${name}, ${url}) is already in use, probably by a process from an earlier run. ` +
          `Find it with: ps -eo pid,pgid,args | grep -v grep | grep -E 'node|npm'`,
      );
    }
  }
}
