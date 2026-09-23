# TV Config Fix — TV Firmware / eMMC Dump Analysis & Repair Toolkit

A desktop application for analyzing and repairing TV firmware and eMMC dumps:
inspect partition layouts across vendor formats, explore EXT4 filesystems,
edit bytes and configuration values with offset-accurate safety rails, verify
checksums, and export a modified dump.

> **Firmware warning:** always work on a **copy** of your dump and keep the
> original untouched. Modifying firmware can make a device unbootable, and an
> "editable" indicator in this tool means the region *can* be written — not
> that changing it is safe for your device. Verify offsets and partition
> boundaries before writing anything back. See [Safety](#safety) below.

## What it does

The toolkit has two main tools:

- **eMMC Tool** (`src/pages/EmmcTool.jsx`) — load a full eMMC dump, detect its
  partition layout (GPT/MBR plus vendor user-area formats), inspect detected
  filesystems, explore EXT4 partitions, edit files, replace partitions, and
  compose/export a modified dump (single file or ZIP).
- **TV Config Tool** (`src/pages/TVConfigTool.jsx`) — load a single firmware /
  config file, inspect it as hex, edit INI-style key=value entries, verify and
  fix CRC fields, and explore it when it contains an EXT4 image.

## Key capabilities

- **Dump analysis** — GPT parsing with header-CRC validation, MBR parsing,
  automatic partition mapping, and firmware-family detection.
- **Vendor user-area formats** — MStar `Part_Map` (`emmc_1630_5840`), Amlogic
  MPT (`aml_mpt`), Realtek `PART.INFO` (`realtek_partinfo`), `blkdevparts`
  (`blkdevparts_mmc`), and U-Boot `mtdparts` (`mtdparts_emmc`), handled through
  a strict format registry where formal maps take precedence over guesses.
- **Inferred filesystem detection** — SquashFS/EXT4 signature scanning that
  reports filesystem regions independently of partition tables (backup
  superblocks are filtered out).
- **EXT4 exploration** — browse directories and read files (extent trees,
  legacy indirect block mappings, inline data, sparse holes).
- **Range-backed EXT4** — partitions over 1 GiB are explored via bounded range
  reads instead of loading the whole partition into memory.
- **EXT4 editing** — in-place file patching, file growth within/beyond
  allocated extents, file creation, and file deletion, in both memory and
  range-backed modes.
- **Hex editor** — fixed-length byte editing (hex + ASCII), search, equal-length
  replace, undo/redo, go-to-offset (editor and physical), drag selection,
  clipboard copy/paste, and a context menu.
- **Physical offset mapping** — logical file offsets resolve to absolute dump
  offsets so you always know *where* a byte lives in the dump.
- **U-Boot environment editing** — `env.txt`-style environments are shown as
  clean text; saving recalculates the CRC32 header and preserves the fixed
  allocation. Oversized edits are rejected instead of corrupting the layout.
- **CRC tools** — CRC32-IEEE (chunked with progress), CRC16-CCITT, and other
  variants, with configurable field position (tail/start/custom) and endianness.
- **Partition replacement & export** — replace partition bytes, compose a full
  modified dump, or export partitions as a ZIP with collision-free names.
- **INI config editing** — edit key=value entries constrained to the writable
  gap before the next entry, so edits cannot shift file layout.

## Partition concepts and status indicators

Different vendors describe eMMC user-area layout in incompatible ways, so the
toolkit normalizes everything into one partition list (`selectDumpParts`).
Each entry carries provenance (`ptType`) and a status:

| Status | Meaning |
| --- | --- |
| `editable` | Normal data partition that can be read and written. |
| `readonly` | Detected but not safe to edit (e.g. too large for in-place editing, or unavailable bytes). |
| `metadata` | Describes layout rather than holding user data (e.g. MStar Part_Map, GPT metadata regions). Not a normal partition. |
| `blocked` | Overlaps another region; hidden from editing to prevent conflicting writes. |
| `nested` | Lives inside another region's byte range; shown for provenance, not edited independently. |

Provenance types you will see include formal map entries, `inferred_fs`
(filesystem found by signature scan, not by any partition table), and
`metadata`. Formal partition maps always take precedence over inferred
regions, and truncated dumps (file smaller than declared sizes) are handled
by clamping reads to available bytes.

## EXT4 support

- **Normal exploration** (partitions up to 1 GiB, or any size with replacement
  bytes): the partition is loaded and browsed in memory. Full read, patch,
  grow, create, and delete support.
- **Range-backed exploration** (partitions over 1 GiB): directory and file
  data are fetched with bounded range reads. Browsing, in-place patching,
  growth, creation, and deletion work through a block overlay; partitions that
  cannot be edited this way are reported read-only with a reason.
- **Physical offset mapping**: single-extent files resolve a base dump offset
  shown in the hex editor; fragmented or sparse files report no single base
  offset rather than a wrong one.
- **Editing safety model**: patches are planned first (`computeInPlacePatch`)
  and rejected when content exceeds allocated space; growth allocates real
  blocks and updates metadata; failed operations leave the image unmutated.
- **Limitations**: very large partitions may be read-only; only regular files
  with extent-based layouts are patchable (directories, indirect/inline-only
  layouts are rejected cleanly).

## Hex editor

The editor (`HexViewer` + `hexEditorCore`) is a **fixed-length overwrite**
editor: every edit replaces bytes in place and the buffer length never
changes, so no edit can shift subsequent physical offsets. Features include
hex/ASCII editing with modified-byte tracking, single- and multi-level
undo/redo (including batched operations), hex/ASCII search with wrap-around,
equal-length replace/replace-all, go-to-offset in editor or physical mode,
copy editor/physical offsets, mouse drag selection, Ctrl+C copy, Ctrl+V paste
(hex, truncated at buffer end), Delete/Backspace as zero-fill, and a
right-click context menu. Keyboard shortcuts are disabled while focus is in
an input field.

## U-Boot environment editing

Files detected as U-Boot environments (CRC32 header + NUL-separated printable
`key=value` text, e.g. `env.txt`) open as clean text: the 4-byte header is
hidden and NUL separators render as newlines. On save, the content is
re-encoded to NUL-separated form, zero-padded back to the exact original
allocation (e.g. 128 KiB), and a fresh little-endian CRC32 is written into the
header. If edited content exceeds the payload capacity, saving **throws an
error and writes nothing** — the environment can never grow and corrupt
neighboring data. Binary files such as `panel.bin` are always routed to the
hex viewer and never treated as text.

## Architecture

React 18 + Vite 6 frontend, packaged with Electron 43 / electron-builder as a
Windows portable app. All parsing and editing logic is dependency-free
JavaScript in `src/lib` operating on `Uint8Array` buffers; large dumps are
accessed through `File.slice`-backed range reads so multi-GB files never need
to be fully loaded.

```
                 +-----------------------------+
                 |        Electron shell       |
                 |  electron/main.cjs (loads   |
                 |  dist/index.html, no menu)  |
                 +-------------+---------------+
                               |
                 +-------------v---------------+
                 |      React pages            |
                 |  EmmcTool / TVConfigTool    |
                 +------+------+-------+------+
                        |      |       |
        +---------------+      |       +----------------+
        |                      |                        |
+-------v-------+   +----------v----------+   +---------v---------+
| tv components |   | parser libraries    |   | editor libraries  |
| HexViewer     |   | emmc / userArea /   |   | hexEditorCore     |
| Ext4Browser   |   | firmware / detect   |   | offsetMap         |
| ConfigEditor  |   | ext4 / ext4Range /  |   | textDecoding      |
| CrcPanel      |   | ext4PatchIo / range |   | binaryDetection   |
| PartitionTable|   | blockOverlay / dump |   | crc32             |
+---------------+   +---------------------+   +-------------------+
```

(The repository also contains a Base44 scaffold — `base44/`,
`src/api/base44Client.js`, auth pages — which is unrelated to the firmware
toolkit itself.)

## Project structure

```
src/
  pages/            EmmcTool.jsx (dump workflow), TVConfigTool.jsx (file workflow)
  components/tv/    HexViewer, Ext4Browser, ConfigEditor, CrcPanel, FileDropzone
  components/emmc/  PartitionTable, UserAreaAnalysis, FilesystemDetections, CrcPanelEmmc, LogPanel
  components/firmware/  FirmwareHeaderPanel
  lib/              Parser/editor libraries (see below)
  lib/userArea/     Strict user-area format registry + partition classification
  api/              Base44 SDK client (scaffold, unrelated to firmware tools)
tests/              31 node:test suites covering parsers, EXT4, editor, CRC, export
electron/           Electron main process (main.cjs)
build/              Windows packaging assets (icon)
dist/               Build output (generated, gitignored)
```

Key libraries in `src/lib`:

- `emmc.js` — GPT/MBR parsing, dump analysis, partition replace/compare.
- `userAreaParser.js` — SoC user-area detection (Amlogic MBR, Realtek, Android boot, filesystem sniffing).
- `userArea/` — strict format registry (`emmc_1630_5840`, `aml_mpt`, `realtek_partinfo`, `blkdevparts_mmc`, `mtdparts_emmc`) and dump-part classification.
- `firmwareParser.js` — firmware analysis incl. `mtdparts` text and firmware-family detection.
- `detectFilesystems.js` — independent SquashFS/EXT4 signature scan.
- `ext4.js` / `ext4Range.js` / `ext4PatchIo.js` — in-memory, range-backed, and overlay-based EXT4 I/O.
- `ext4OffsetMap.js`, `offsetMap.js` — logical-to-physical offset mapping.
- `blockOverlay.js`, `rangeReader.js`, `dumpCompose.js`, `exploreSession.js` — large-file editing plumbing (4 KiB overlay blocks, bounded reads, 1 GiB memory/range threshold).
- `hexEditorCore.js` — pure hex-editing logic (selection, history, search, replace).
- `textDecoding.js`, `binaryDetection.js` — U-Boot env codec and binary/text classification.
- `crc32.js`, `binaryUtils.js`, `zipWriter.js`, `formatFileSize.js` — checksums, byte helpers, ZIP export, size formatting.

## Development setup

Prerequisites: Node.js (v22+ recommended) and npm.

```bash
npm install     # install dependencies
npm run dev     # start the Vite dev server, open the printed URL
npm test        # run the test suite
npm run build   # production build into dist/
```

Windows portable package (existing configuration, no extra setup):

```bash
npm run electron:build   # builds dist/ then packages the portable EXE
```

Lint and typecheck are available via `npm run lint` and `npm run typecheck`.

## Build / package output

- `npm run build` emits the web app into `dist/` (HTML, CSS, JS assets).
- `npm run electron:build` additionally runs electron-builder with the
  existing `portable` Windows target, producing `dist/TV Config Fix 1.0.0.exe`
  alongside `dist/win-unpacked/`.
- `dist/`, `node_modules/`, `.env*` files, and raw dumps (`firmware-samples/`,
  `EMMC_*.bin`) are gitignored — **do not commit generated artifacts**.

## Testing

```bash
npm test
```

The suite uses plain `node:test` (no extra framework): 31 test files covering
partition-map parsers, detection precedence, EXT4 read/patch/grow/create/
delete paths, range-backed I/O, the hex-editor core, CRC variants, U-Boot
env round-trips, and ZIP export. At this documentation checkpoint the `npm
test` script passed **699 tests, 0 failures, 13 skipped** (skips are optional
live-dump tests requiring local reference files). Note: the `npm test` script
currently enumerates 27 of the 31 files — `ext4BrowserFixes`,
`ext4LegacyAndHoles`, `inferredPartitions`, and `realtekPartInfo` exist on
disk but are not in the script; run them explicitly with
`node --test tests/<name>.test.js` if you touch those areas.

## Safety

- Work on **copies**; keep original dumps untouched and archived.
- `editable` means the tool can write the region — it does **not** mean the
  change is safe for your TV model. Writing wrong data to boot, environment,
  or calibration partitions can brick a device.
- Verify partition boundaries and absolute offsets before saving, especially
  after any operation that grows a file.
- For U-Boot environments, the tool enforces fixed allocation and CRC
  integrity, but the *content* of your key=value changes is still your
  responsibility.

## Current packaging note

The current Windows portable baseline is **TV Config Fix 1.0.0**,
approximately **205.91 MB** (215,908,190 bytes) — a normal size for an
Electron portable build. This is a measured baseline only; packaging
optimization or migration is out of scope unless explicitly tasked.
