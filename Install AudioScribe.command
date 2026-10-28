#!/bin/bash
# AudioScribe installer for macOS.
# Sets up the transcription tools (Miniforge + Whisper + Montreal Forced
# Aligner), lets After Effects load the panel, and installs it.
# Safe to run again: anything already installed is skipped or updated.

cd "$(dirname "$0")" || exit 1
EXT_SRC="$(pwd)/com.ace.audioscribe"
LOG="$HOME/Library/Logs/AudioScribe-install.log"
mkdir -p "$(dirname "$LOG")"

say() { printf "\n\033[1m%s\033[0m\n" "$1"; }
fail() {
  printf "\n\033[31mSomething went wrong:\033[0m %s\n" "$1"
  echo "Details are in $LOG — send that file to whoever gave you AudioScribe."
  read -r -p "Press Return to close." _
  exit 1
}
run() { "$@" >>"$LOG" 2>&1; }

clear
echo "AudioScribe installer"
echo "This takes about 10 minutes the first time, mostly downloading."
echo "Log: $LOG"
echo "---- $(date)" >>"$LOG"

[ -d "$EXT_SRC" ] || fail "Keep this file in the same folder as com.ace.audioscribe."

if pgrep -x "After Effects" >/dev/null 2>&1; then
  echo
  echo "After Effects is open. Please quit it, then press Return."
  read -r _
fi

# 1. Miniforge (a self-contained Python), reusing any existing conda install.
say "1/5  Python"
BASE=""
for d in "$HOME/miniforge3" "$HOME/miniconda3" "$HOME/anaconda3" "$HOME/mambaforge" \
         "/opt/homebrew/Caskroom/miniforge/base" "/opt/miniconda3" "/opt/anaconda3"; do
  if [ -x "$d/bin/conda" ]; then BASE="$d"; break; fi
done
if [ -z "$BASE" ]; then
  echo "Downloading Miniforge…"
  INST="/tmp/Miniforge3-$$.sh"
  curl -fsSL -o "$INST" \
    "https://github.com/conda-forge/miniforge/releases/latest/download/Miniforge3-$(uname)-$(uname -m).sh" \
    || fail "Couldn't download Miniforge. Check your internet connection."
  run bash "$INST" -b -p "$HOME/miniforge3" || fail "Miniforge didn't install."
  rm -f "$INST"
  BASE="$HOME/miniforge3"
else
  echo "Found an existing install at $BASE"
fi
CONDA="$BASE/bin/conda"

# 2. The "aligner" environment with MFA.
say "2/5  Speech aligner"
ENV="$BASE/envs/aligner"
if [ ! -x "$ENV/bin/python" ]; then
  echo "Creating the environment (the slow part)…"
  run "$CONDA" create -y -n aligner -c conda-forge montreal-forced-aligner python=3.11 \
    || fail "Couldn't create the aligner environment."
else
  echo "Already set up."
fi
export PATH="$ENV/bin:$PATH"

# 3. Whisper and the English aligner models.
say "3/5  Whisper and language models"
run "$ENV/bin/python" -m pip install --upgrade faster-whisper || fail "Couldn't install faster-whisper."
run "$ENV/bin/mfa" model download acoustic english_us_arpa || fail "Couldn't download the aligner model."
run "$ENV/bin/mfa" model download dictionary english_us_arpa || fail "Couldn't download the aligner dictionary."
"$ENV/bin/python" -c "import faster_whisper" >>"$LOG" 2>&1 || fail "faster-whisper didn't install correctly."

# 4. Allow After Effects to load the panel.
say "4/5  After Effects permissions"
for v in 9 10 11 12 13; do defaults write "com.adobe.CSXS.$v" PlayerDebugMode 1; done
killall cfprefsd >/dev/null 2>&1

# 5. Install the panel.
say "5/5  Installing the panel"
DEST="$HOME/Library/Application Support/Adobe/CEP/extensions"
mkdir -p "$DEST" || fail "Couldn't create $DEST"
rm -rf "$DEST/com.ace.audioscribe"
cp -R "$EXT_SRC" "$DEST/" || fail "Couldn't copy the panel."
xattr -dr com.apple.quarantine "$DEST/com.ace.audioscribe" >/dev/null 2>&1

printf "\n\033[32mDone.\033[0m\n"
echo "Open After Effects, then Window › Extensions › AudioScribe."
echo "Select a layer with dialogue and press Transcribe."
echo "(The first transcription downloads the Whisper model, so give it a minute.)"
read -r -p "Press Return to close." _
