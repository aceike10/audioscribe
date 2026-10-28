# AudioScribe v2

A transcript panel for After Effects. Select a footage layer with dialogue and
transcribe it. Click a word, or an individual sound inside a word, to move the
playhead there. One button builds a captions layer with word-by-word highlight.

This version replaces AudioScribe v1, using the same bundle id.

## What it does

- **Words view:** the transcript, grouped by phrase. The word under the
  playhead lights up as you scrub or step frames. Click any word to jump to the
  frame where it starts.
- **Sounds view:** splits the current word into its individual speech sounds
  (phonemes such as `F R EY M`). Each sound is sized by its duration and
  labelled with its comp frame and a rough mouth shape. The arrows step one
  sound at a time. A note flags frames that hold two or more sounds, which is
  common at 24 fps.
- **Edit the transcript:** double-click a word to fix it.
  - Enter or clicking away saves, and Esc cancels.
  - Tab and Shift+Tab save and move to the next or previous word, so you can
    proofread a line from the keyboard.
  - Typing several words splits the original word's time between them.
    Clearing a word deletes it.
  - ⌘Z undoes edits. Edits save into the cached transcript and flow into
    captions you create afterwards.
  - An edited word loses its sound-level timing until you transcribe again.
- **Find:** type a word or phrase and press Enter to jump to the next match.
- **Waveform strip:** shows the waveform of the caption being spoken, with
  word boundaries and labels. Click or drag on it to move the playhead. With it
  focused, Left/Right step one frame (Shift for ten).
- **Create captions:** builds a caption rig at the top of the comp:
  - **Captions – <layer>**: a null holding every control in Effect Controls
    (Background, Per Line, Padding X/Y, Roundness, BG Color, BG Opacity, Line
    Spacing, Word Highlight, Highlight Color). Move or scale the null to move
    the captions.
  - **· Top / · Bottom**: one text layer per caption line. Change font, size and
    color on these as normal.
  - **· BG Top / · BG Bottom / · BG Block**: rounded boxes sized by expression
    to the text. The **Per Line** checkbox switches between one box per line
    and one box around the whole caption. **Background** turns boxes off.
  - Captions break at sentence ends, at pauses over 0.7 s, or at the length
    limit. With 2 lines, each caption splits at the most balanced word
    boundary.
  - Word highlight: every word has a marker whose comment is
    `<index in line> <word>` (`-1` clears), read by a Range Selector
    expression, so it follows the voice during real playback.
  - Don't rename the Top/Bottom layers: the boxes find them by name.
  - The panel buttons set the defaults: **Highlight** on/off, and **Box**
    (Off, Per line, Block). Lines (1 or 2) and line length are in Settings.
- **Stays in sync:** words are stored in source time and mapped through the
  layer's Start Time and Stretch on every poll. Sliding, trimming, or
  stretching the layer is fine. Words outside the in/out points are dimmed and
  left out of captions.
- **Only the part you use:** by default the panel transcribes only the stretch
  of source between the layer's in and out points, plus a second either side.
  Five seconds of a seven-minute clip takes seconds, not minutes.
  - Set Settings › Transcribe to "The whole file" if you'd rather do it once.
  - If you later extend the layer past what was transcribed, the footer tells
    you, and pressing Transcribe again fills in the new part.
- **Caching:** results are cached per file, model, language and range. Any
  cached transcript that covers the layer's range is reused, so trimming
  inside it never re-transcribes.
  - macOS: `~/Library/Application Support/AudioScribe/cache`
  - Windows: `%APPDATA%\AudioScribe\cache`

## Limits in v1

- **No updates during spacebar playback.** The panel can't read the playhead
  while AE plays a RAM preview. It follows scrubbing and frame stepping. The
  captions layer plays in sync because it's native keyframes.
- **Footage layers only.** Precomps aren't supported yet.
- **Time remapping is ignored.** If it's on, the panel warns you and word
  positions will be off.
- **English only for sound-level timing.** Whisper handles other languages for
  words. The MFA models used here are English.

## Setup (once)

### 1. Python environment with Whisper and the aligner

The simplest setup is one conda environment that holds both tools. Use
Miniforge or Miniconda.

```bash
conda create -n aligner -c conda-forge montreal-forced-aligner python=3.11
conda activate aligner
pip install faster-whisper
mfa model download acoustic english_us_arpa
mfa model download dictionary english_us_arpa
which python   # Windows: where python
```

The panel finds Python in an `aligner` environment under `~/miniforge3`,
`~/miniconda3` or `~/anaconda3` by itself. If yours is elsewhere, paste the
`which python` path into **Settings › Python**. The helper finds `mfa` next to
that Python automatically.

Without MFA, everything still works at word level. Sounds view will tell you
that sound-level timing needs the aligner.

### 2. Allow unsigned extensions

**macOS:**
```bash
defaults write com.adobe.CSXS.11 PlayerDebugMode 1
defaults write com.adobe.CSXS.12 PlayerDebugMode 1
killall cfprefsd
```

**Windows:**
```bat
reg add HKCU\Software\Adobe\CSXS.11 /v PlayerDebugMode /t REG_SZ /d 1 /f
reg add HKCU\Software\Adobe\CSXS.12 /v PlayerDebugMode /t REG_SZ /d 1 /f
```

### 3. Install the panel

Copy the `com.ace.audioscribe` folder to the CEP extensions folder, replacing
v1 if it's there:

- macOS: `~/Library/Application Support/Adobe/CEP/extensions/`
- Windows: `C:\Users\<you>\AppData\Roaming\Adobe\CEP\extensions\`

Restart After Effects, then open **Window › Extensions › AudioScribe**. Requires
AE 2022 (22.0) or later, because the panel uses `layerByID`.

## Sharing with friends

Give friends the **AudioScribe Installer** zip, ideally as a GitHub Release
download. Inside are installers for Mac and Windows that set up everything:
Python, Whisper, the aligner, After Effects permissions, and the panel. The
panel finds that Python by itself, so there's nothing to type in Settings.

Before sharing, put your repo in `config.json` (`"updateRepo":
"yourname/audioscribe"`). Every panel then checks your repo for updates
automatically. A public repo is simplest, since friends need no token.

## Updates without Terminal

The panel can update itself from a GitHub repo. Once this is set up, a new
version shows up as an **Update to x.y.z** button at the top of the panel. One
click downloads it, installs it, and reloads the panel, with no AE restart.

### One-time setup

1. **Create the repo.** Make a free account at github.com, then click **New
   repository**. Name it `audioscribe` and choose Private or Public.
   - Private: only you can see the code, but the panel needs a token (step 3).
   - Public: anyone can see the code, and no token is needed.
2. **Upload the panel.** On the new repo's page, click **uploading an existing
   file**. Open the `com.ace.audioscribe` folder and drag everything inside it
   (`CSXS`, `client`, `helper`, `host`, `README.md`) onto the page. Drag the
   contents, not the folder itself. Use Chrome, since Safari doesn't upload
   folders. Click **Commit changes**.
3. **Private repo only: make a token.** Go to GitHub › your avatar ›
   **Settings › Developer settings › Personal access tokens › Fine-grained
   tokens › Generate new token**.
   - Repository access: **Only select repositories** › `audioscribe`.
   - Permissions › Repository › **Contents: Read-only**.
   - Generate it and copy it.
4. **Connect the panel.** Either edit `config.json` in the repo to say
   `"updateRepo": "yourname/audioscribe"` (pencil icon on GitHub), which
   covers every copy of the panel, or enter it in the panel's Settings ›
   Update repo. Paste the token if you made one, then press **Check for
   updates**. It should say you have the latest version.

### Publishing an update

When you get a new version, open the repo on GitHub, click **Add file › Upload
files**, drag in the new contents the same way, and commit. Every copy of the
panel pointed at the repo offers the update. Panels check by themselves every
12 hours, or straight away when you press **Check for updates**.

Notes:
- Updates are only offered when the version number in `CSXS/manifest.xml` goes
  up.
- Settings, cached transcripts and edits are kept across updates.
- Rarely, an update changes how AE loads the panel. Those need a full AE
  restart, and the release notes will say so.
- To track a branch other than `main`, write the repo as
  `yourname/audioscribe#branch`.

## Using it

1. Select the dialogue layer and press **Transcribe**. The first run downloads
   the Whisper model. Progress shows in the footer.
2. Click words, or switch to **Sounds** and click individual sounds.
3. Set the caption length and highlight color in Settings, then press
   **Create captions layer**. It is a single undo step.

To transcribe again (for example after changing the model), tick **Ignore cache
on next transcribe** in Settings and press Transcribe. This replaces that
transcript, including any edits you made to it.

## Troubleshooting

- **"Python not found":** AE doesn't see your shell's PATH. Put the full path
  in Settings › Python.
- **"MFA failed, keeping word timing only":** run the `mfa model download`
  commands above inside the same environment. The footer shows the end of
  MFA's error.
- **"After Effects returned: EvalScript error":** the host script didn't load.
  Check that `host/host.jsx` is in the extension folder and restart AE.
- **Debugging the panel:** put a `.debug` file in the extension root with a
  port, then open `localhost:<port>` in Chrome.

## Transcript format

The helper writes the format below, in source seconds.

```json
{ "aligned": true, "segments": [{"start": 0.4, "end": 3.1}],
  "words": [{"word": "Every", "start": 0.41, "end": 0.66, "seg": 0,
             "phones": [{"p": "EH", "start": 0.41, "end": 0.49}]}] }
```
