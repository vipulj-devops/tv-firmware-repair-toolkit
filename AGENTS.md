# AGENTS.md — Canonical AI-Agent Guidance

This file is the **single canonical instruction document for all AI coding
agents** working on this repository. (`CLAUDE.md` was removed; it only pointed
here.) Read this file before doing anything else. The user-facing overview
lives in `README.md`; this file is the operational manual.

If your agent supports Agent Skills and you are doing Base44-specific work
(scaffold/auth/backend, not the firmware toolkit), see the Base44 references
at the bottom. For firmware/EXT4/hex-editor work — which is this repo's real
purpose — this file is authoritative.

## 1. Project overview

**TV Config Fix** (`com.tvconfigfix.app`) is a desktop TV firmware / eMMC dump
analysis and repair toolkit. Users load raw dumps or firmware files and can:

- detect partition layouts across GPT, MBR, and five vendor user-area formats;
- scan for filesystems independently of partition tables;
- browse and edit EXT4 filesystems, including multi-GB partitions via
  range-backed I/O;
- edit bytes in a fixed-length hex editor with physical-offset awareness;
- edit U-Boot environment text with CRC/allocation protection;
- verify/fix CRC fields, replace partitions, and export modified dumps.

There are two tools: **EmmcTool** (`src/pages/EmmcTool.jsx`, full-dump
workflow) and **TVConfigTool** (`src/pages/TVConfigTool.jsx`, single-file
workflow). Everything else in `src/` supports them.

## 2. Technology stack

- React 18 (JSX, no TypeScript in app code), Vite 6, Tailwind CSS, Radix UI.
- Electron 43 + electron-builder 26, Windows `portable` target.
- Plain `node:test` suites, no test framework dependency.
- Parser/editor libraries are dependency-free JavaScript operating on
  `Uint8Array`; large files use `File.slice`-backed range reads.
- Base44 scaffold (`base44/`, `src/api/base44Client.js`, auth pages,
  `@base44/*` packages, `vite.config.js` plugin) — unrelated to the firmware
  toolkit; touch it only for explicitly Base44-scoped tasks.

## 3. Architecture

```
Electron shell (electron/main.cjs)
  loads dist/index.html in a menuless BrowserWindow
        |
React pages: EmmcTool (dump) / TVConfigTool (file)
        |
  +----- tv components -------+--- parser libs ---------+---- editor libs ----+
  | HexViewer (view/edit)     | emmc (GPT/MBR)          | hexEditorCore (pure)|
  | Ext4Browser (ext4 UI)     | userAreaParser +        | offsetMap           |
  | ConfigEditor (ini kv)     |   userArea/ registry    | textDecoding (uboot)|
  | CrcPanel (+Emmc variant)  | firmwareParser          | binaryDetection     |
  | PartitionTable et al.     | detectFilesystems       | crc32               |
  |                           | ext4 / ext4Range /      +---------------------+
  |                           | ext4PatchIo (ext4 I/O)  | large-file plumbing |
  |                           | blockOverlay/rangeReader| dumpCompose/zip/    |
  +---------------------------+ exploreSession          | exploreSession      |
                                                        +---------------------+
```

Data flow for a dump: bytes → `analyzeDump`/`analyzeUserArea`/`analyzeFirmware`
→ `selectDumpParts` (one normalized partition list with status + provenance)
→ UI tables → explore (memory or range path) → edit via overlays/patches →
compose/export. Nothing is written to the user's original file; edits live in
replacements/overlays until export.

## 4. Repository structure

- `src/pages/` — `EmmcTool.jsx`, `TVConfigTool.jsx` (+ Base44 auth pages).
- `src/components/tv/` — `HexViewer`, `Ext4Browser`, `ConfigEditor`,
  `CrcPanel`, `FileDropzone`.
- `src/components/emmc/` — `PartitionTable`, `UserAreaAnalysis`,
  `FilesystemDetections`, `CrcPanelEmmc`, `LogPanel`.
- `src/components/firmware/` — `FirmwareHeaderPanel`.
- `src/lib/` — all parser/editor libraries (see §5).
- `src/lib/userArea/` — `binary.js` (LE readers), `registry.js` (strict format
  registry), `selectDumpParts.js` (classification).
- `tests/` — 31 `node:test` suites (see §11).
- `electron/main.cjs` — Electron entry (`"main"` in package.json).
- `build/icon.png` — packaging icon referenced by electron-builder config.
- `dist/` — generated output, **gitignored, never commit**.
- `.gitignore` also excludes `node_modules`, `.env*`, `firmware-samples/`,
  `EMMC_*.bin` (raw dumps must never be committed).

## 5. Important source files/modules

| Module | Role |
| --- | --- |
| `src/lib/emmc.js` | GPT (offset find, header-CRC validation), MBR, `autoMapPartitions`, `analyzeDump`, partition `read`/`replace`, `compareDumps`. |
| `src/lib/userAreaParser.js` | `detectSocUserArea`, Amlogic MBR, Realtek, Android boot, filesystem sniffing, `userAreaToParts`. |
| `src/lib/userArea/registry.js` | `USER_AREA_STRICT_FORMATS`, `detectRegisteredFormat`. |
| `src/lib/userArea/selectDumpParts.js` | `STRICT_USER_AREA_TYPES`, `selectDumpParts`, `classifyDumpParts`; assigns `status`/`ptType`/provenance. |
| `src/lib/firmwareParser.js` | `analyzeFirmware`, `mtdparts` text parsing, Realtek layout, firmware-family detection. |
| `src/lib/detectFilesystems.js` | `scanFilesystems` (SquashFS+EXT4), `filterBackupSuperblocks`. |
| `src/lib/ext4.js` | In-memory EXT4: superblock, extents + legacy indirect + inline + holes, read, `computeInPlacePatch`, `patchFile`, `growAndPatchFile`, `deleteFile`, `createFile`. |
| `src/lib/ext4Range.js` | Range-backed equivalents (`*Range` readers, `…WithInfo`, alloc/free-space). |
| `src/lib/ext4PatchIo.js` | Overlay I/O ops: `patchExistingFileIo`, `growAndPatchFileIo`, `createFileIo`, `deleteFileIo`, alloc/free/dirents. |
| `src/lib/ext4OffsetMap.js`, `src/lib/offsetMap.js` | Logical→physical byte mapping (`buildExt4FileOffsetMap`, `createOffsetMap`). |
| `src/lib/rangeReader.js`, `src/lib/blockOverlay.js` | Bounded cached reads; 4 KiB overlay blocks, 256 MiB dirty cap. |
| `src/lib/exploreSession.js` | 1 GiB memory/range threshold (`usesMemoryEditor`), user-facing reason strings. |
| `src/lib/dumpCompose.js`, `src/lib/zipWriter.js` | Dump/partition composition with replacements/overlays; ZIP export. |
| `src/lib/hexEditorCore.js` | Pure editing logic: selection, history, search, equal-length replace, goto. |
| `src/lib/textDecoding.js` | `decodeTextFile`/`encodeTextFile`, `crc32_ieee`, `detectUbootEnv`. |
| `src/lib/binaryDetection.js` | `isBinaryFile`, `BINARY_EXTENSIONS`. |
| `src/lib/crc32.js`, `src/lib/binaryUtils.js` | CRC32/CRC16 + variants; hex/ascii/u32 helpers. |

## 6. Major implemented functionality

Partition detection (GPT/MBR + 5 strict user-area formats + inferred FS scan);
EXT4 browse/edit (patch, grow, create, delete; memory + range paths); fixed-
length hex editing (search/replace/undo/clipboard/goto); physical-offset
mapping and display; U-Boot env text editing with capacity guard; CRC
verify/fix with progress; INI key=value editing bounded by entry gaps;
partition replacement, dump composition, ZIP export; truncated-dump handling
(clamped reads, unavailable-partition states).

## 7. Partition format/parser architecture

- Strict user-area types (`emmc_1630_5840`, `aml_mpt`, `realtek_partinfo`,
  `blkdevparts_mmc`, `mtdparts_emmc`) are detected via the registry and take
  precedence over inferred regions (`detectionPrecedence` tests enforce this).
- `selectDumpParts` merges GPT/MBR parts, strict user-area parts, firmware
  parts, and `inferred_fs` hits into one list with `status`:
  `editable | readonly | metadata | blocked | nested`.
- `metadata` regions (Part_Map, GPT tables) and `blocked` (overlapping)
  regions must never be offered as normal editable partitions; `nested`
  regions exist for provenance only.
- Partial dumps: every consumer must clamp to available bytes (`declaredSize`
  vs `availableSize`, `truncated`/`unavailable` flags); never invent ranges
  without evidence.

## 8. EXT4 architecture

- `ext4.js` is the in-memory implementation; `ext4Range.js` mirrors it with a
  `reader.read()` interface for large partitions; `ext4PatchIo.js` performs
  overlay writes for the range path. Keep the three in behavioral sync —
  `WithInfo` callers pass the full `inode`, and `read…` results are sized to
  `i_size` with holes zero-filled.
- Supported layouts: extent trees, legacy indirect blocks (single/double/
  triple), inline data, sparse holes. Only regular extent-based files are
  patchable; anything else must fail cleanly with zero mutation.
- `Ext4Browser.jsx` holds the UI contract: `WithInfo` reads for display,
  original reads for edits, `decodedMeta` for U-Boot text, overlay I/O in
  range mode. File create/delete are wired in both modes.

## 9. Hex editor architecture

Pure logic in `hexEditorCore.js`, rendering/interaction in `HexViewer.jsx`.
The model is **fixed-length overwrite**: buffer length is invariant, so no
edit can shift physical offsets. History is batch-based (paste/replace-all/
delete are single undo units). Search parse → match → replace all operate on
equal-length needles; length mismatches are rejected, not adapted. `HexViewer`
adds baseOffset/offsetMap display, editor-vs-physical goto, context menu, and
clipboard — all guarded by `isEditableFormControl` so shortcuts never fire
from inputs.

## 10. U-Boot environment handling

`decodeTextFile(raw, path) → { displayText, meta }` hides the 4-byte LE CRC32
header and renders NUL separators as newlines (trailing padding stripped);
`encodeTextFile(meta, editedText)` re-encodes, zero-pads to the exact original
`allocationSize`, recomputes the CRC, and **throws when payload exceeds
`payloadAlloc`** — callers (`Ext4Browser.save`) must let that exception abort
the save so neither memory nor range path writes anything. Round-trip without
edits must be byte-identical. `isBinaryFile` (extension list + 1 KiB
printable/non-printable sample, NUL-tolerant) routes binaries like
`panel.bin` to the hex viewer; never weaken it to "fix" a text case.

## 11. Testing architecture

Plain `node:test` + `node:assert`, one suite per area, synthetic fixtures
preferred (real dumps under `firmware-samples/` are optional/skipped
and must never be committed). Run targeted files first
(`node --test tests/<name>.test.js`), then the full `npm test` script, then
`npm run build`. **Known gap:** the `npm test` script enumerates 27 of the 31
files — `ext4BrowserFixes`, `ext4LegacyAndHoles`, `inferredPartitions`, and
`realtekPartInfo` exist but are not in the script, so run them explicitly when
touching those areas. Never edit tests just to make them pass; fix the source
or report the failure.

## 12. Build commands

- `npm install` — dependencies.
- `npm run dev` — Vite dev server (primary local workflow for this toolkit).
- `npm test` — full suite (see §11).
- `npm run build` — production web build into `dist/`.
- `npm run lint` / `npm run typecheck` — available validations.
- `base44 dev` and `.env.local` / Base44 CLI apply only to the Base44
  scaffold, not to firmware-toolkit development; default to `npm run dev`.

## 13. Electron packaging

Existing configuration only: `"main": "electron/main.cjs"`, `"build"` field
in package.json (`appId com.tvconfigfix.app`, files `dist`+`electron`+
`package.json`, `win.target: portable`, icon `build/icon.png`), script
`electron:build` = `npm run build && electron-builder --win portable`.
Baseline output: `dist/TV Config Fix 1.0.0.exe`, ~205.91 MB — normal for
Electron, recorded as a measurement, not a problem. Do not redesign packaging,
do not add config to shrink it, do not migrate frameworks, do not touch
dependencies for packaging reasons, unless explicitly tasked.

## 14. Git workflow

**MANDATORY: PLAN → REVIEW → BUILD → TEST → MANUAL VALIDATION → COMMIT → PUSH.**

1. **Investigate first** — read code/tests, reproduce; do not modify files
   during investigation (plan mode means zero writes, including via shell).
2. **Plan before implementing** non-trivial work; get the plan reviewed.
3. **Build** the smallest safe change; prefer editing existing files.
4. **Test**: targeted suites → full `npm test` → `npm run build` (+ lint).
5. **Manual validation** for UI/tool behavior (e.g. `npm run dev` smoke test,
   real-dump checks with local-only files).
6. **Review** `git status` + `git diff` (+ `git diff --check`); stage only
   intended files with explicit `git add <paths>`.
7. **Commit** with a clear message; **push only when explicitly asked**.

## 15. Git safety rules

- NEVER `git add .` for feature work; NEVER commit or push unasked — not even
  "obvious" fixes. Report and wait.
- Always inspect `git status`, `git diff`, and the staged diff before
  committing; verify `git log --oneline` to know what you are extending.
- Do not `git restore`/checkout, reset, rebase, or force-push anything
  without an explicit request — a dirty file may be the user's intentional
  work. Investigate unexplained modifications, don't discard them.
- Do not commit `dist/`, `node_modules/`, `.env*`, dumps, or test outputs.
- A lingering `M` with empty `git diff` and matching
  `git hash-object`/`git rev-parse HEAD:` is a stat phantom — refresh with
  `git update-index --refresh`, don't "fix" the file. (This occurred with
  `src/lib/ext4Range.js`; it resolved via refresh.)
- CRLF/LF: repo Git config may emit line-ending notices; never mass-convert
  line endings to silence them.

## 16. Firmware safety rules

This project mutates firmware bytes. Agents must: preserve source dumps
(work on copies; reference dumps stay local and uncommitted); never shift
physical offsets unintentionally (fixed-length overwrite is the default —
see §9); respect partition boundaries and the `status` model (§7); treat
`metadata` as non-data and `blocked`/`nested` as non-editable; assume nothing
about filesystem type or size — validate; use bounded range reads for large
dumps (never `arrayBuffer()` a multi-GB partition); preserve provenance when
multiple representations exist; and never present a green/`editable` status
as a guarantee that modifying firmware is safe for the device.

## 17. Parser rules

Formal maps beat inferred regions; backup-GPT handling needs care
(`filterBackupSuperblocks`); duplicate names/representations are kept
deliberately (collision-free export handles them); malformed or truncated
maps fail safe (clamp, mark, continue — don't throw away the whole analysis);
vendor formats are not interchangeable — gate each parser on its own evidence
and keep precedence tests green.

## 18. EXT4 rules

Large partitions use the range path (§8); keep memory/range behavior
identical. Map physical ↔ logical through `offsetMap`, never by assumption.
Plan-then-write: oversized content must throw before any mutation
(`computeInPlacePatch`, U-Boot guard). Growth allocates real blocks and
updates all metadata; verify neighbors in tests. Never physically shift
unrelated structures. Keep `allocationSize` sacred for fixed-allocation files.

## 19. Hex editor rules

Fixed-length overwrite only. Do NOT reintroduce deletion/compaction that
shifts subsequent bytes unless the architecture is explicitly redesigned and
validated end-to-end. Keep shortcuts behind the form-control guard, keep
history batched, keep replace equal-length, keep cursor/selection semantics.

## 20. Testing rules

Targeted → full → build; lint when available; manual validation for UI.
Real dumps only from local paths, never committed. Investigate failures;
don't weaken assertions, skip, or delete tests to get green. Keep
memory-failure and >4 GiB regression coverage intact.

## 21. Documentation rules

Update `README.md` (human overview) and this file (agent operations) whenever
architecture, workflows, commands, or major functionality change. Document
from source truth, not from memory; no invented features, no nonexistent
files, no stale commands. Keep checkpoint numbers (tests, sizes, hashes)
labeled with their date/context — they rot.

## 22. Known current state

Checkpoint (documentation written, tree clean and synchronized with
`origin/master`):

- `4d0ce1b` "Fix EXT4 parser startup syntax error" — removed a stray `}` at
  the end of `src/lib/ext4.js` that broke Vite import analysis at startup.
- `npm test`: 699 passed, 0 failed, 13 skipped (optional live-dump skips).
- `npm run build` + `npm run electron:build`: success; portable EXE verified
  launchable at ~205.91 MB.
- Do not depend on these hashes for normal work; re-check `git log`/status.

## 23. Naming/terminology

eMMC; User Area; Part_Map; GPT / MBR; PART.INFO; MPT; blkdevparts; mtdparts;
EXT4; SquashFS; U-Boot environment; inode / extent; physical offset
(absolute dump byte) vs logical offset (within file/partition); range-backed;
block overlay; metadata / provenance; editable / readonly / blocked / nested;
fixed-length overwrite; payload vs allocation (`payloadAlloc`).

## Base44 references (scaffold work only)

- CLI overview: https://docs.base44.com/developers/references/cli/get-started/overview.md
- Agent skills: https://docs.base44.com/developers/backend/overview/skills.md
- If your agent supports Agent Skills, `npx skills add base44/skills` before
  Base44-specific work. Prefer `base44 dev` and the existing SDK client
  (`src/api/base44Client.js`) for scaffold tasks; never commit `.env.local`.
