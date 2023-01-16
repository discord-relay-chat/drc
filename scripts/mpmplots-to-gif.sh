#!/bin/bash

NUM_FILES_TO_SOURCE=72
INTER_FRAME_DELAY_MS=25

SCRIPT_DIR=$(dirname $(readlink -f ${BASH_SOURCE[0]}))
STATIC_PATH=$(readlink -f ${1:-$SCRIPT_DIR/http/static})
ALL_FILES_FILE=$SCRIPT_DIR/.allfiles
FILES_FILE=$SCRIPT_DIR/.giffiles

ls -1 $STATIC_PATH/*mpmplot.png > $ALL_FILES_FILE

cat $ALL_FILES_FILE | tail -n $NUM_FILES_TO_SOURCE > $FILES_FILE
convert -delay $INTER_FRAME_DELAY_MS -loop 1 -dispose previous @$FILES_FILE $STATIC_PATH/mpmplot.gif
rm $FILES_FILE
echo "Generated $STATIC_PATH/mpmplot.gif from $NUM_FILES_TO_SOURCE source frames"

ALL_COUNT=$(cat $ALL_FILES_FILE | wc -l)
RM_MARK=$(printf "%0.0f" $(echo "$NUM_FILES_TO_SOURCE * 1.10" | bc))
if (( $ALL_COUNT > $RM_MARK )); then
  RM_NUM=$(echo "$ALL_COUNT - $RM_MARK" | bc)
  cat $ALL_FILES_FILE | head -n $RM_NUM | xargs -I{} rm {}
  echo "Removed $RM_NUM old plots"
fi

rm $ALL_FILES_FILE