/**
 * Extract Active Drum Channels
 * ----------------------------
 * Right-click a Drum Rack (or the MIDI track / clip that hosts one) →
 * "Extract to Separate Tracks". Every pad that has a device loaded *and* is
 * actually triggered by MIDI in the track's clips is placed on its own
 * dedicated track. If the Drum Rack's track lives inside a group, the extracted
 * tracks stay inside that same group bus.
 *
 * How it works (and why):
 * The SDK cannot move a device between tracks, set MIDI routing, or create a
 * track at a chosen index / inside a chosen group. The one primitive that does
 * everything we need is `song.duplicateTrack()`: it copies the whole track —
 * drum rack and all — and, exactly like in Live, a track duplicated inside a
 * group remains in that group. So for each active pad we duplicate the host
 * track, then in the copy we silence every *other* active pad and trim the
 * clips' notes down to that one pad's trigger note. The result is one clean,
 * in-group track per drum, each keeping its pad's full original signal chain.
 *
 * Before any change is made, a confirmation dialog lists what will be extracted
 * and lets the user choose whether the original track is muted (the default,
 * non-destructive) or deleted.
 *
 * Note on scope: the SDK 1.0.0 has no API for Live's native "Ungroup" or
 * "Bounce to New Track" commands, so the extension stops at producing the
 * isolated MIDI tracks — ungroup or commit-to-audio by hand afterwards.
 */
import {
  initialize,
  DataModelObject,
  Device,
  RackDevice,
  DrumRack,
  Track,
  Clip,
  MidiClip,
  Simpler,
  type ActivationContext,
  type Handle,
  type ExtensionContext,
  type NoteDescription,
} from "@ableton-extensions/sdk";

// Inlined as a string by esbuild (see build.ts `loader: { ".html": "text" }`).
import confirmDialog from "./confirm.html";

type Ctx = ExtensionContext<"1.0.0">;

/** Result posted back by the confirmation dialog. */
interface ConfirmResult {
  confirmed: boolean;
  deleteSource?: boolean;
  /**
   * How pads are grouped into output tracks, as arrays of trigger notes. Pads
   * the user "links" (e.g. open + closed hi-hat) share a group so they extract
   * to one track — keeping their Drum Rack choke group working. A lone pad is a
   * group of one. Absent ⇒ one track per pad.
   */
  groups?: number[][];
}

const COMMAND_ID = "extractActiveDrumChannels.run";
const ACTION_TITLE = "Extract to Separate Tracks";

export function activate(activation: ActivationContext) {
  const context = initialize(activation, "1.0.0");

  context.commands.registerCommand(COMMAND_ID, (arg: unknown) => {
    void run(context, arg as Handle).catch((e) =>
      console.error("[Extract Drum Channels] Failed:", e),
    );
  });

  // Register under every scope a user might reach for: the Drum Rack device
  // itself, the MIDI track that hosts it, and any MIDI clip on that track.
  for (const scope of ["DrumRack", "MidiTrack", "MidiClip"] as const) {
    void context.ui
      .registerContextMenuAction(scope, ACTION_TITLE, COMMAND_ID)
      .catch((e) =>
        console.error(`[Extract Drum Channels] Could not register on ${scope}:`, e),
      );
  }
}

async function run(context: Ctx, handle: Handle): Promise<void> {
  // The action can be triggered from a Drum Rack, a MIDI track, or a MIDI clip.
  // Resolve whichever it is down to a host track and the Drum Rack on it.
  const located = locateDrumRack(context, handle);
  if (!located) {
    console.warn(
      "[Extract Drum Channels] No Drum Rack found for the clicked item — nothing to extract.",
    );
    return;
  }
  const { hostTrack, rack, rackPath } = located;

  // Pads with a device loaded. These are the ones we may need to silence when
  // isolating, and the only ones worth extracting — a note hitting an empty pad
  // makes no sound.
  const chains = rack.chains;
  const deviceIndices: number[] = [];
  for (let i = 0; i < chains.length; i++) {
    if (chains[i]!.devices.length > 0) deviceIndices.push(i);
  }

  // "Active" = a loaded pad that is actually triggered by (non-muted) MIDI notes
  // somewhere in this track's clips.
  const triggeredPitches = collectTriggeredPitches(hostTrack);
  const extractIndices = deviceIndices.filter((i) =>
    triggeredPitches.has(chains[i]!.receivingNote),
  );

  if (extractIndices.length === 0) {
    console.warn(
      "[Extract Drum Channels] No loaded pad is triggered by MIDI in this track's clips — nothing to extract.",
    );
    return;
  }

  // Pre-compute each active pad's trigger note and a sample-derived name.
  const pads = extractIndices.map((index) => {
    const chain = chains[index]!;
    return { index, note: chain.receivingNote, label: padName(chain.devices) ?? "Drum" };
  });

  const group = hostTrack.groupTrack;
  console.log(
    `[Extract Drum Channels] ${pads.length} active pad(s) on "${hostTrack.name}"` +
      (group ? ` — keeping inside group "${group.name}".` : " — not in a group."),
  );

  // Confirm with the user. They choose what happens to the source track and may
  // "link" pads (e.g. open + closed hi-hat) so those extract onto one shared
  // track — which keeps their Drum Rack choke group functioning.
  const choice = await confirmExtraction(context, {
    trackName: hostTrack.name,
    groupName: group ? group.name : null,
    pads: pads.map((p) => ({ label: p.label, note: p.note })),
  });
  if (!choice.confirmed) {
    console.log("[Extract Drum Channels] Cancelled by user.");
    return;
  }
  const deleteSource = choice.deleteSource === true;

  // Turn the grouping into output tracks. Each output is a set of pad notes that
  // share one track (a lone pad is a set of one). Default ⇒ one track per pad.
  const byNote = new Map(pads.map((p) => [p.note, p]));
  const noteGroups: number[][] =
    choice.groups && choice.groups.length > 0
      ? choice.groups.map((g) => g.filter((n) => byNote.has(n))).filter((g) => g.length > 0)
      : pads.map((p) => [p.note]);

  // One colour per output track, hue-spaced from a random start.
  const startHue = Math.random() * 360;
  const outputs = noteGroups.map((notes, i) => {
    const members = notes.map((n) => byNote.get(n)!);
    return {
      noteSet: new Set(notes),
      label: members.map((p) => p.label).join(" + ") || "Drum",
      color: hslToRgbInt((startHue + (i * 360) / noteGroups.length) % 360, 0.6, 0.55),
    };
  });

  await context.ui.withinProgressDialog(
    "Extracting drum channels…",
    { progress: 0 },
    async (update, signal) => {
      // Build one track per output (group of one or more pads).
      for (let i = 0; i < outputs.length; i++) {
        signal.throwIfAborted();
        const out = outputs[i]!;
        await update(`Extracting ${out.label}`, (i / outputs.length) * 90);

        // Duplicate the host track. The copy lands right after the original,
        // inside the same group (if any).
        const dup = await context.application.song.duplicateTrack(hostTrack);

        // Keep this output's pad(s); empty every other loaded pad. Keeping more
        // than one pad in the rack is what preserves their choke group.
        const dupRack = resolveDrumRack(dup, rackPath);
        for (const other of deviceIndices) {
          if (out.noteSet.has(chains[other]!.receivingNote)) continue;
          await emptyChain(dupRack.chains[other]!);
        }

        // Trim every MIDI clip to this output's note(s), then name + colour.
        filterTrackNotes(dup, out.noteSet);
        dup.name = out.label;
        nameAndColorClips(dup, out.label, out.color);
      }

      // Apply the user's choice to the original track.
      if (deleteSource) {
        await update("Deleting source track", 100);
        await context.application.song.deleteTrack(hostTrack);
      } else {
        await update("Muting source track", 100);
        hostTrack.mute = true;
      }
    },
  ).then(
    () =>
      console.log(
        deleteSource
          ? "[Extract Drum Channels] Done. Source track was deleted."
          : `[Extract Drum Channels] Done. Source track "${hostTrack.name}" was muted — ` +
              "delete it manually if you no longer need it.",
      ),
    (e) => {
      if (e instanceof Error && e.name === "AbortError") {
        console.warn(
          "[Extract Drum Channels] Cancelled. Any tracks already created were kept.",
        );
        return;
      }
      throw e;
    },
  );
}

/**
 * Resolves whatever was right-clicked (a Drum Rack, a MIDI track, or a MIDI
 * clip) into the host track, the Drum Rack on it, and the rack's device path.
 * Returns null if no Drum Rack can be found.
 */
function locateDrumRack(
  context: Ctx,
  handle: Handle,
): {
  hostTrack: Track<"1.0.0">;
  rack: DrumRack<"1.0.0">;
  rackPath: number[];
} | null {
  const obj = context.getObjectFromHandle(handle, DataModelObject);

  let hostTrack: Track<"1.0.0"> | null = null;
  let rackPath: number[] | null = null;

  if (obj instanceof DrumRack) {
    hostTrack = findHostTrack(obj);
    if (hostTrack) rackPath = findDevicePath(hostTrack.devices, obj.handle.id);
  } else if (obj instanceof Track) {
    hostTrack = obj;
    rackPath = findFirstDrumRackPath(obj.devices);
  } else if (obj instanceof Clip) {
    hostTrack = findHostTrack(obj);
    if (hostTrack) rackPath = findFirstDrumRackPath(hostTrack.devices);
  }

  if (!hostTrack || !rackPath) return null;
  return { hostTrack, rack: resolveDrumRack(hostTrack, rackPath), rackPath };
}

/**
 * Shows the confirmation dialog and returns the user's choice. The pad list,
 * track name and group are injected into the HTML template between its `DATA`
 * markers. Returns `{ confirmed: false }` if the dialog is cancelled or dismissed.
 */
async function confirmExtraction(
  context: Ctx,
  data: {
    trackName: string;
    groupName: string | null;
    pads: { label: string; note: number }[];
  },
): Promise<ConfirmResult> {
  // Embed the data as a JS literal. Neutralise `<`/`>` so a stray "</script>"
  // in a track name can't break out of the inlined HTML.
  const json = JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e");
  const html = confirmDialog.replace(
    /\/\*DATA\*\/[\s\S]*?\/\*DATA\*\//,
    () => `/*DATA*/${json}/*DATA*/`,
  );
  const url = `data:text/html,${encodeURIComponent(html)}`;

  try {
    const raw = await context.ui.showModalDialog(url, 420, 560);
    return JSON.parse(raw) as ConfirmResult;
  } catch (e) {
    console.warn("[Extract Drum Channels] Dialog dismissed:", e);
    return { confirmed: false };
  }
}

/** Walks up the object hierarchy from any object to the Track that contains it. */
function findHostTrack(node: DataModelObject<"1.0.0">): Track<"1.0.0"> | null {
  let current: DataModelObject<"1.0.0"> | null = node.parent;
  while (current) {
    if (current instanceof Track) return current;
    current = current.parent;
  }
  return null;
}

/**
 * Returns the path to a device within a track's device tree as alternating
 * indices: [deviceIndex, chainIndex, deviceIndex, …, deviceIndex]. The path
 * always has odd length and ends on the device itself.
 */
function findDevicePath(
  devices: Device<"1.0.0">[],
  targetId: bigint,
): number[] | null {
  for (let di = 0; di < devices.length; di++) {
    const device = devices[di]!;
    if (device.handle.id === targetId) return [di];
    if (device instanceof RackDevice) {
      const chainList = device.chains;
      for (let ci = 0; ci < chainList.length; ci++) {
        const sub = findDevicePath(chainList[ci]!.devices, targetId);
        if (sub) return [di, ci, ...sub];
      }
    }
  }
  return null;
}

/** Path to the first Drum Rack found anywhere in a device tree, or null. */
function findFirstDrumRackPath(devices: Device<"1.0.0">[]): number[] | null {
  for (let di = 0; di < devices.length; di++) {
    const device = devices[di]!;
    if (device instanceof DrumRack) return [di];
    if (device instanceof RackDevice) {
      const chainList = device.chains;
      for (let ci = 0; ci < chainList.length; ci++) {
        const sub = findFirstDrumRackPath(chainList[ci]!.devices);
        if (sub) return [di, ci, ...sub];
      }
    }
  }
  return null;
}

/** Re-navigates a device path (from {@link findDevicePath}) inside a track to its Drum Rack. */
function resolveDrumRack(track: Track<"1.0.0">, path: number[]): DrumRack<"1.0.0"> {
  let devices = track.devices;
  for (let i = 0; i < path.length; i += 2) {
    const device = devices[path[i]!];
    if (i === path.length - 1) {
      if (device instanceof DrumRack) return device;
      throw new Error("Expected a Drum Rack at the end of the device path.");
    }
    if (!(device instanceof RackDevice)) {
      throw new Error("Expected a Rack device while walking the device path.");
    }
    devices = device.chains[path[i + 1]!]!.devices;
  }
  throw new Error("Empty device path.");
}

/** Removes every device from a pad's chain, leaving it silent. */
async function emptyChain(chain: { devices: Device<"1.0.0">[]; deleteDevice: (d: Device<"1.0.0">) => Promise<void> }): Promise<void> {
  // Snapshot first — the list shrinks as we delete.
  for (const device of [...chain.devices]) {
    await chain.deleteDevice(device);
  }
}

/** Every MIDI clip on a track: session slots, arrangement, and take lanes. */
function midiClipsOf(track: Track<"1.0.0">): MidiClip<"1.0.0">[] {
  return [
    ...track.clipSlots.map((slot) => slot.clip),
    ...track.arrangementClips,
    ...track.takeLanes.flatMap((lane) => lane.clips),
  ].filter((clip): clip is MidiClip<"1.0.0"> => clip instanceof MidiClip);
}

/** Set of pitches triggered by at least one non-muted note in the track's clips. */
function collectTriggeredPitches(track: Track<"1.0.0">): Set<number> {
  const pitches = new Set<number>();
  for (const clip of midiClipsOf(track)) {
    for (const note of clip.notes) {
      if (note.muted !== true) pitches.add(note.pitch);
    }
  }
  return pitches;
}

/**
 * Trims every MIDI clip on a track down to just `pitch`, so each extracted drum
 * track's clips contain only that drum's hits.
 *
 * We deliberately do NOT delete clips that come out empty. The SDK's arrangement
 * note reads aren't reliably scoped per clip (`clip.notes` returns the whole
 * track's notes, and the note times don't line up cleanly with clip boundaries),
 * so any automatic "this clip is empty" check risks deleting a clip that really
 * does contain notes — i.e. silently dropping MIDI. A leftover blank clip is
 * harmless and easy to delete by hand; lost notes are not. So we only trim.
 */
function filterTrackNotes(track: Track<"1.0.0">, pitches: Set<number>): void {
  for (const clip of midiClipsOf(track)) {
    const notes = notesForPitches(clip, pitches);
    if (notes !== null) {
      try { clip.notes = notes; } catch (e) {
        console.warn("[Extract Drum Channels] Failed to trim a clip:", e);
      }
    }
  }
}

/** Notes of `clip` whose pitch is in `pitches`; null if notes can't be read. */
function notesForPitches(clip: MidiClip<"1.0.0">, pitches: Set<number>): NoteDescription[] | null {
  try {
    return clip.notes.filter((note) => pitches.has(note.pitch));
  } catch (e) {
    console.warn("[Extract Drum Channels] Could not read a clip's notes:", e);
    return null;
  }
}

/**
 * A human-friendly name for a pad. Drum Rack pads usually nest their instrument
 * inside an Instrument Rack, so we recurse through the pad's device tree and
 * prefer the file name of the first loaded sample (a Simpler's sample), then
 * fall back to the first non-rack device's name (e.g. a Sampler titled by its
 * sample). Returns null if nothing useful is found.
 */
function padName(devices: Device<"1.0.0">[]): string | null {
  return findSampleName(devices) ?? findInstrumentName(devices);
}

/** File name (no directory, no extension) of the first Simpler sample found. */
function findSampleName(devices: Device<"1.0.0">[]): string | null {
  for (const device of devices) {
    if (device instanceof Simpler) {
      const path = device.sample?.filePath;
      if (path) return baseName(path);
    }
    if (device instanceof RackDevice) {
      for (const chain of device.chains) {
        const found = findSampleName(chain.devices);
        if (found) return found;
      }
    }
  }
  return null;
}

/** Name of the first non-rack device found anywhere in the tree. */
function findInstrumentName(devices: Device<"1.0.0">[]): string | null {
  for (const device of devices) {
    if (device instanceof RackDevice) {
      for (const chain of device.chains) {
        const found = findInstrumentName(chain.devices);
        if (found) return found;
      }
    } else {
      return device.name;
    }
  }
  return null;
}

/** Strips directory and extension: "/x/y/Kick 01.wav" → "Kick 01". */
function baseName(path: string): string {
  const file = path.split(/[/\\]/).pop() ?? path;
  return file.replace(/\.[^.]+$/, "");
}

/** Renames and recolours every MIDI clip on a track to match the track. */
function nameAndColorClips(track: Track<"1.0.0">, name: string, color: number): void {
  for (const clip of midiClipsOf(track)) {
    try {
      clip.name = name;
      clip.color = color;
    } catch (e) {
      console.warn("[Extract Drum Channels] Could not name/colour a clip:", e);
    }
  }
}

/** HSL (h in [0,360), s/l in [0,1]) → a Live clip colour as a 0xRRGGBB integer. */
function hslToRgbInt(h: number, s: number, l: number): number {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }
  const R = Math.round((r + m) * 255);
  const G = Math.round((g + m) * 255);
  const B = Math.round((b + m) * 255);
  return (R << 16) | (G << 8) | B;
}
