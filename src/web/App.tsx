import { useEffect, useState } from 'react';
import { act, useApp, useSettings, useStatus } from './lib/store';
import { dismiss, useToasts } from './lib/toast';
import { showDetail, useDetail } from './lib/workspace';
import { panelById } from './panels/registry';
import { Glareshield } from './components/Glareshield';
import { Workspace } from './components/Workspace';
import { CommandBar } from './components/CommandBar';
import { SetupWizard } from './components/SetupWizard';
import { SettingsDialog } from './components/SettingsDialog';
import { Button, IconButton, Modal } from './components/ui';

function Toasts() {
  const toasts = useToasts();
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast--${t.level}`} role={t.level === 'error' ? 'alert' : 'status'}>
          <span>{t.message}</span>
          <IconButton icon="close" label="Dismiss" onClick={() => dismiss(t.id)} />
        </div>
      ))}
    </div>
  );
}

function DetailView() {
  const id = useDetail();
  const def = id ? panelById(id) : undefined;
  if (!def) return null;
  const C = def.component;
  return (
    <Modal title={def.title} onClose={() => showDetail(null)} wide="full" className="detail">
      <C detail />
    </Modal>
  );
}

function ConnectionBanner() {
  const status = useStatus();
  const online = useApp((s) => s.online);
  const hasAircraft = useApp((s) => s.telemetry != null);
  if (!online) {
    return <div className="banner banner--error">SkyDeck has stopped. Start SkyDeck.exe again and this page reconnects by itself.</div>;
  }
  if (status?.connection === 'searching') {
    return (
      <div className="banner">
        <span className="banner__pulse" aria-hidden="true" />
        <span>{status.message}</span>
        <Button size="sm" onClick={() => act({ type: 'demo.start' })}>
          Try the demo aircraft
        </Button>
      </div>
    );
  }
  if (status?.connection === 'connected' && !hasAircraft) {
    return (
      <div className="banner">
        <span className="banner__pulse" aria-hidden="true" />
        <span>{status.message}</span>
      </div>
    );
  }
  if (status?.connection === 'demo') {
    return (
      <div className="banner banner--demo">
        <span>{status.message}</span>
        <Button size="sm" onClick={() => act({ type: 'demo.stop' })}>
          Stop the demo
        </Button>
      </div>
    );
  }
  return null;
}

export function App() {
  const settings = useSettings();
  const online = useApp((s) => s.online);
  const [commandOpen, setCommandOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCommandOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!settings) {
    return <div className="boot">{online ? 'Loading SkyDeck…' : 'Connecting to SkyDeck…'}</div>;
  }
  if (!settings.setupComplete) return <SetupWizard />;

  return (
    <div className="app">
      <Glareshield onCommand={() => setCommandOpen(true)} onSettings={() => setSettingsOpen(true)} />
      <ConnectionBanner />
      <main className="workspace">
        <Workspace />
      </main>
      <DetailView />
      <CommandBar open={commandOpen} onClose={() => setCommandOpen(false)} />
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
      <Toasts />
    </div>
  );
}
