import { useEffect, useState } from 'react';
import { api, type FolderListing } from '../lib/api';
import { Button, Icon, Modal } from './ui';

/** Browses folders on the PC running SkyDeck (the browser itself cannot hand out folder paths). */
export function FolderPicker({ start, onPick, onClose }: { start: string | null; onPick: (path: string) => void; onClose: () => void }) {
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [error, setError] = useState('');

  const go = (path: string | null) => {
    setError('');
    api
      .listFolders(path)
      .then(setListing)
      .catch((e: Error) => setError(e.message));
  };
  useEffect(() => go(start), [start]);

  const name = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;

  return (
    <Modal
      title="Choose the MSFS folder"
      onClose={onClose}
      wide
      footer={
        <>
          <span className={listing?.isMsfs ? 'pill pill--green' : 'muted small'}>{listing?.isMsfs ? 'This looks like an MSFS folder' : 'Open the folder that contains UserCfg.opt'}</span>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!listing?.path} onClick={() => listing && onPick(listing.path)}>
            Use this folder
          </Button>
        </>
      }
    >
      <div className="folder-picker">
        <div className="folder-picker__path">
          <Button size="sm" disabled={listing?.parent == null} onClick={() => go(listing?.parent || null)}>
            Up
          </Button>
          <code>{listing?.path || 'This PC'}</code>
        </div>
        {error && <p className="error-text">{error}</p>}
        <ul className="folder-picker__list">
          {listing?.folders.map((f) => (
            <li key={f}>
              <button type="button" onClick={() => go(f)}>
                <Icon name="layout" size={14} />
                {name(f)}
              </button>
            </li>
          ))}
          {listing && listing.folders.length === 0 && <li className="muted">No sub-folders.</li>}
        </ul>
        <p className="muted small">
          Steam: <code>%APPDATA%\Microsoft Flight Simulator</code>. Microsoft Store / Xbox app: <code>%LOCALAPPDATA%\Packages\Microsoft.FlightSimulator_8wekyb3d8bbwe\LocalCache</code>.
        </p>
      </div>
    </Modal>
  );
}
