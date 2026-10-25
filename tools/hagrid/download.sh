#!/bin/sh
# HaGRID v2 annotations with MediaPipe landmarks (no images). Validation only.
# The host must be allowed in the environment's network settings.
set -e
DIR=${1:-hagrid_annotations}
mkdir -p "$DIR"
curl -fL -o "$DIR/annotations.zip" https://rndml-team-cv.obs.ru-moscow-1.hc.sbercloud.ru/datasets/hagrid_v2/annotations_with_landmarks/annotations.zip
(cd "$DIR" && unzip -q -o annotations.zip)
echo "annotations in $DIR"
