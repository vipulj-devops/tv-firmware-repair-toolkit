import { Link } from 'react-router-dom';
import { FileCog, HardDrive, House } from 'lucide-react';

const linkClass =
  'text-xs rounded-md border border-border px-2.5 py-1.5 hover:bg-accent transition-colors flex items-center gap-1.5 shrink-0';

export default function ToolNav({ current }) {
  return (
    <nav className="ml-2 flex items-center gap-2" aria-label="Toolkit">
      <Link to="/" className={linkClass}>
        <House className="w-3.5 h-3.5" /> Home
      </Link>
      {current !== 'tvconfig' && (
        <Link to="/tvconfig" className={linkClass}>
          <FileCog className="w-3.5 h-3.5" /> TVConfig
        </Link>
      )}
      {current !== 'emmc' && (
        <Link to="/emmc" className={linkClass}>
          <HardDrive className="w-3.5 h-3.5" /> EMMC Tool
        </Link>
      )}
    </nav>
  );
}
