import { useEffect, useState } from 'react';
import type { LinkInstallStatus } from '../../shared/types';
import { api } from '../lib/api';
import { useStatus } from '../lib/store';
import { toast } from '../lib/toast';
import { Button } from './ui';

/** Install / update / remove SkyDeck Link, the in-sim add-on that edits the G1000 NXi's flight plan directly. */
export function LinkSettings() {
  const status = useStatus();
  const [install, setInstall] = useState<LinkInstallStatus | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.linkStatus().then(setInstall).catch(() => setInstall(null));
  }, []);

  const run = async (fn: () => Promise<LinkInstallStatus>, done: string) => {
    setBusy(true);
    try {
      setInstall(await fn());
      toast(done, 'success');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const connected = status?.link.connected;
  return (
    <div className="link-box">
      <p>
        Aircraft with the G1000 NXi only read a flight plan from MSFS when a flight starts. SkyDeck Link is a small add-on
        that lets SkyDeck change the NXi's flight plan during the flight, including departures, arrivals, approaches and
        direct-to.
      </p>
      <p className="small">
        {connected ? (
          <span className="tone-green">Connected to the {status?.link.avionics}.</span>
        ) : install?.state === 'installed' ? (
          <span className="muted">Installed. It connects when you fly an aircraft with the G1000 NXi (restart MSFS after installing).</span>
        ) : (
          <span className={install?.state === 'unavailable' ? 'warning-text' : 'muted'}>{install?.message ?? 'Checking…'}</span>
        )}
      </p>
      <div className="chip-row">
        {install?.state === 'not-installed' && (
          <Button variant="primary" disabled={busy} onClick={() => void run(api.installLink, 'SkyDeck Link installed. Restart MSFS to load it.')}>
            Install SkyDeck Link
          </Button>
        )}
        {install?.state === 'outdated' && (
          <Button variant="primary" disabled={busy} onClick={() => void run(api.installLink, 'SkyDeck Link updated. Restart MSFS to load it.')}>
            Update SkyDeck Link
          </Button>
        )}
        {(install?.state === 'installed' || install?.state === 'outdated') && (
          <Button variant="ghost" disabled={busy} onClick={() => void run(api.uninstallLink, 'SkyDeck Link removed. Restart MSFS to finish.')}>
            Remove
          </Button>
        )}
      </div>
      {install?.communityPath && install.state !== 'unavailable' && (
        <p className="muted small">
          Adds a <code>skydeck-link</code> folder to <code>{install.communityPath}</code>. It changes no other files; removing the folder undoes it.
        </p>
      )}
    </div>
  );
}
