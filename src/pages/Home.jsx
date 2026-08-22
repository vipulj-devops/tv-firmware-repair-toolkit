import { Link } from 'react-router-dom';
import { FileCog, HardDrive, Wrench } from 'lucide-react';

const tools = [
  {
    to: '/tvconfig',
    title: 'TVConfig Repair Tool',
    description: 'Open TV configuration images, inspect and edit values, repair CRC checksums, and rebuild a patched file.',
    icon: FileCog,
    iconBg: 'bg-emerald-600',
  },
  {
    to: '/emmc',
    title: 'EMMC Dump Tool',
    description: 'Analyze eMMC dumps, map partitions, extract or replace images, and explore supported filesystems.',
    icon: HardDrive,
    iconBg: 'bg-sky-600',
  },
];

export default function Home() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border bg-card/50 backdrop-blur sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-5 py-4 flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-slate-800 flex items-center justify-center">
            <Wrench className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-base font-semibold tracking-tight">TV Firmware Repair Toolkit</h1>
            <p className="text-xs text-muted-foreground">Choose a tool to get started</p>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-5 py-10">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {tools.map((tool) => {
            const Icon = tool.icon;
            return (
              <Link
                key={tool.to}
                to={tool.to}
                className="group flex h-full flex-col rounded-xl border border-border bg-card p-6 hover:bg-accent/60 transition-colors"
              >
                <div className={`w-10 h-10 rounded-lg ${tool.iconBg} flex items-center justify-center mb-4`}>
                  <Icon className="w-5 h-5 text-white" />
                </div>
                <h2 className="text-base font-semibold tracking-tight group-hover:underline underline-offset-4">
                  {tool.title}
                </h2>
                <p className="mt-2 text-sm text-muted-foreground leading-relaxed">
                  {tool.description}
                </p>
              </Link>
            );
          })}
        </div>
      </main>
    </div>
  );
}
