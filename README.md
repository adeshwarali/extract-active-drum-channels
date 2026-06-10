# Extract Active Drum Channels 🥁

**A Live 12 extension that splits a Drum Rack's active pads onto separate tracks — in one click, while keeping them inside your group bus.**

Right-click a Drum Rack and every drum that's actually used in your clips gets its own track, each still playing through its original pad (full signal chain intact), named after the sample it's playing, with its clips renamed to match and given a distinct color. It's the "explode my drum rack into stems-ready tracks" button Live has never had.

---

## Why?

Producers have wanted a quick way to break a Drum Rack out into per-drum tracks since forever — for separate processing, routing, mixing, or committing to audio. Doing it by hand means duplicating tracks, deleting pads, and trimming notes over and over. This does the whole thing in one click, and it's smart about it:

- It only extracts pads you **actually played** — no clutter of empty tracks.
- It **keeps the new tracks in the same group** as the original, so your drum bus keeps working.
- It names each track after the **sample loaded on the pad**, renames the clips to match, and gives each drum a **distinct color**.
- It **deletes clips that end up empty**, so each track keeps clips only where its drum actually plays.

---

## Requirements

- **Ableton Live 12 Suite — Beta build, version 12.4.5 or later.** Extensions are a Suite + Beta feature.
- macOS or Windows.

---

## Install

1. Download `Extract-Active-Drum-Channels-0.1.0.ablx`.
2. In Live: **Settings → Extensions**.
3. Either **drag the `.ablx` onto the "Drag and drop to install" area**, or click **Choose file** and select it.
4. Live confirms the install and asks you to **restart**. Restart Live.
5. After restart it appears under **Installed Extensions → Extract Active Drum Channels**.

To remove it later: **Settings → Extensions → Extract Active Drum Channels → Uninstall** (then restart).

---

## How to use

1. Make sure your Drum Rack track has at least one **MIDI clip** with notes (that's how it knows which pads are "active").
2. **Right-click** any of these and choose **Extensions → Extract to Separate Tracks**:
   - the **Drum Rack** device itself (its title bar), or
   - the **MIDI track** header that hosts it, or
   - a **MIDI clip** on that track.
3. A dialog lists the drums it found and lets you choose what happens to the original track:
   - **Muted** *(default, non-destructive)* — kept but silenced.
   - **Deleted** — removed entirely.
4. Click **Extract**. A progress bar shows each drum being separated.

That's it — you'll have one track per drum, sitting in the same group, each named after its sample.

---

## What exactly it does

For every **active** pad — one that has a device loaded **and** is triggered by at least one (non-muted) MIDI note in the track's clips — it creates a dedicated track that:

- plays **only that drum**, with the pad's **full original signal chain** intact (it still runs through the Drum Rack, so every pad effect, send, and macro is preserved — it sounds identical), and
- has its clips **trimmed to that pad's note**, so the track's MIDI contains only that drum's hits.

Any clip that ends up **empty** after trimming (a clip where that drum never played) is **deleted**, so each track keeps clips only where its drum actually plays — no blank clips cluttering the arrangement.

Loaded-but-unplayed pads, and notes that hit empty pads, are ignored. If the source track is in a group, the new tracks land **inside that same group**. The original track is then muted (or deleted, your choice).

**Naming & color.** Each track is named after the sample loaded on the pad — e.g. a pad playing `STRTR Kick - Go To.wav` becomes a track named `STRTR Kick - Go To`. Every clip on that track is **renamed to match**, and each drum gets a **distinct color** (hue-spaced so no two clash). The colors are applied to the **clips**; see *Good to know* for why the track headers themselves aren't recolored.

---

## After extracting (optional next steps)

The extension stops at clean, isolated **MIDI tracks**. If you want to go further, two quick native Live moves finish the job:

- **Commit to audio:** select the new tracks → **Bounce to New Track** (`⌘B` / `Ctrl+B`).
- **Flatten the rack** to a plain instrument track: select the Drum Rack on a track → **Ungroup** (`⌘⇧G` / `Ctrl+Shift+G`).

(These are Live menu commands that the current Extensions SDK can't trigger from inside an extension — see *Good to know* below.)

---

## Good to know

- **Save your Set first.** This adds tracks and mutes/deletes the original. Undo works, but it's a sequence of steps (the SDK can't batch them into one undo), so a quick save is the easy safety net.
- **Each extracted track still contains the whole Drum Rack**, with just one pad making sound. That's heavier than moving a single instrument out, but it's what guarantees the sound is identical — and it's the only approach the beta SDK allows.
- **Naming:** works best with **Simpler**-based pads (factory drum racks, sampled kits). For **Sampler** pads the SDK doesn't expose the sample path, so it falls back to the device name (usually still the sample name). Pads with no instrument get named `Drum`.
- **Colors land on clips, not track headers.** The SDK can set a *clip's* color but has no track-color property, so each extracted track's **clips** are recolored while the **track header** keeps the source rack's color. Recoloring the headers to match is a quick manual step in Live (right-click a track → pick a color).
- **No MIDI clip = nothing to extract.** "Active" is defined by the notes in your clips.

---

## How it works (for the curious / other devs)

The Extensions SDK 1.0.0 deliberately exposes a small surface. It has **no** API to move a device between tracks, set MIDI routing, delete a chain, create a track at a chosen index/group, ungroup a rack, bounce/freeze, or set a **track's color**. So a literal clone of Live's native "Extract Chains" isn't reachable.

The one primitive that gets us there is **`song.duplicateTrack()`**: it copies the entire track (Drum Rack and all), and — exactly like duplicating in Live's UI — a track duplicated inside a group **stays in that group**. So per active pad the extension: (1) duplicates the host track, (2) empties every *other* active pad in the copy, and (3) filters the copy's clips down to that pad's `receivingNote`. Pad → note mapping comes from `DrumChain.receivingNote`; sample names from walking each pad's device chain to the first `Simpler.sample`.

---

## Build from source

A standard Node/TypeScript extension project.

> **You need the Ableton Extensions SDK** (currently a gated beta) to build from
> source — it is **not** included in this repo, as Ableton's license doesn't allow
> redistributing the SDK on its own. `package.json` references the SDK and CLI as
> local tarballs (`file:../ableton-extensions-sdk-*.tgz`). Download the SDK, then
> point those two paths at your copy before installing.

```sh
npm install
npm run package    # type-checks, bundles, and writes the .ablx
```

The `.ablx` is written to the project root. `npm start` hot-loads a dev build into a running Live with Developer Mode enabled (**Settings → Extensions → Developer Mode**).

---

## Credits

Built by **Ali** with the [Ableton Extensions SDK](https://ableton.github.io/extensions-sdk/). Beta software — feedback and PRs welcome. Not affiliated with Ableton.
