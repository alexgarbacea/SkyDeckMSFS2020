import { useState } from 'react';
import { api } from '../lib/api';
import { useSettings, useStatus } from '../lib/store';
import { toast } from '../lib/toast';
import { Button, Modal, Section, Segmented, Switch } from './ui';
import { FolderPicker } from './FolderPicker';
import { LinkSettings } from './LinkSettings';

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const settings = useSettings();
  const status = useStatus();
  const [picking, setPicking] = useState(false);
  const [simbrief, setSimbrief] = useState(settings?.simbriefUser ?? '');
  if (!settings) return null;

  const save = (patch: Parameters<typeof api.saveSettings>[0], message?: string) =>
    api
      .saveSettings(patch)
      .then(() => message && toast(message, 'success'))
      .catch((e: Error) => toast(e.message, 'error'));

  return (
    <Modal title="Settings" onClose={onClose} wide>
      <div className="settings">
        <Section title="Simulator folder">
          <p>
            {settings.msfsDataPath ? <code>{settings.msfsDataPath}</code> : <span className="warning-text">Not set. Importing the World Map flight plan won't work.</span>}
          </p>
          <div className="chip-row">
            <Button onClick={() => setPicking(true)}>Change folder…</Button>
            <Button variant="ghost" onClick={() => void save({ setupComplete: false })}>
              Run the setup again
            </Button>
          </div>
        </Section>

        <Section title="SkyDeck Link (flight plans for the G1000 NXi)">
          <LinkSettings />
        </Section>

        <Section title="Units">
          <div className="form-grid">
            <span className="form-grid__label">Altimeter</span>
            <Segmented label="Pressure units" value={settings.units.pressure} onChange={(pressure) => void save({ units: { ...settings.units, pressure } })} options={[{ value: 'inHg', label: 'inHg' }, { value: 'hPa', label: 'hPa' }]} />
            <span className="form-grid__label">Weight</span>
            <Segmented label="Weight units" value={settings.units.weight} onChange={(weight) => void save({ units: { ...settings.units, weight } })} options={[{ value: 'lbs', label: 'lb' }, { value: 'kg', label: 'kg' }]} />
          </div>
        </Section>

        <Section title="SimBrief">
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              void save({ simbriefUser: simbrief.trim() }, 'SimBrief username saved.');
            }}
          >
            <input value={simbrief} onChange={(e) => setSimbrief(e.target.value)} placeholder="Username or pilot ID" aria-label="SimBrief username" />
            <Button type="submit" size="sm">
              Save
            </Button>
          </form>
        </Section>

        <Section title="Network">
          <Switch
            checked={settings.allowLan}
            onChange={(allowLan) => void save({ allowLan }, allowLan ? 'Network access turned on.' : 'Network access turned off.')}
            label="Let other devices on my network open SkyDeck"
            hint="Anyone on your home network could then control the sim."
          />
          {settings.allowLan && status?.lanUrls.length ? (
            <p className="small">
              Open {status.lanUrls.map((u, i) => (
                <span key={u}>
                  {i > 0 && ' or '}
                  <code>{u}</code>
                </span>
              ))}{' '}
              on the other device.
            </p>
          ) : null}
          <Switch checked={settings.openBrowserOnStart} onChange={(openBrowserOnStart) => void save({ openBrowserOnStart })} label="Open SkyDeck in the browser when it starts" />
        </Section>

        <Section title="About">
          <p className="small muted">
            SkyDeck {status?.version}. Airport and navaid data from OurAirports (public domain). Map tiles by Esri, HERE, Garmin and OpenStreetMap contributors. Fonts: B612 (Airbus) and Barlow Semi Condensed. SIDs, STARs and approaches come from your simulator.
          </p>
        </Section>
      </div>
      {picking && (
        <FolderPicker
          start={settings.msfsDataPath}
          onClose={() => setPicking(false)}
          onPick={(path) => {
            setPicking(false);
            api
              .inspectFolder(path)
              .then((c) => save({ msfsDataPath: c.dataPath, msfsPackagesPath: c.packagesPath }, 'Simulator folder saved.'))
              .catch((e: Error) => toast(e.message, 'error'));
          }}
        />
      )}
    </Modal>
  );
}
