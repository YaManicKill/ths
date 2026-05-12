#!/usr/bin/env python3
import argparse
import json
import mimetypes
import os
import sys


def fail(message: str) -> None:
    print(message, file=sys.stderr)
    sys.exit(1)


def load_mutagen():
    try:
        from mutagen.id3 import ID3, ID3NoHeaderError, APIC, CHAP, CTOC, TIT2
    except Exception as exc:  # pragma: no cover
        fail(
            "Python package 'mutagen' is required for MP3 chapter image embedding. "
            "Install with: python3 -m pip install --user mutagen"
        )
    return ID3, ID3NoHeaderError, APIC, CHAP, CTOC, TIT2


def guess_mime(image_path: str) -> str:
    mime, _ = mimetypes.guess_type(image_path)
    return mime or "image/jpeg"


def read_chapters(chapters_json_path: str):
    with open(chapters_json_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    if not isinstance(data, list):
        fail("chapters JSON must be a list")

    chapters = []
    for i, chapter in enumerate(data):
        try:
            start_seconds = float(chapter["startSeconds"])
            end_seconds = float(chapter["endSeconds"])
            title = str(chapter["title"])
            toc = bool(chapter.get("toc", True))
            image_path = str(chapter["imagePath"])
        except Exception:
            fail(f"Invalid chapter payload at index {i}")

        if end_seconds < start_seconds:
            end_seconds = start_seconds

        chapters.append(
            {
                "start_ms": int(round(start_seconds * 1000)),
                "end_ms": int(round(end_seconds * 1000)),
                "title": title,
                "toc": toc,
                "image_path": image_path,
            }
        )

    return chapters


def embed(mp3_path: str, chapters):
    ID3, ID3NoHeaderError, APIC, CHAP, CTOC, TIT2 = load_mutagen()

    try:
        tags = ID3(mp3_path)
    except ID3NoHeaderError:
        tags = ID3()

    # Remove existing chapter structures so we replace deterministically.
    for key in list(tags.keys()):
        if key.startswith("CHAP") or key.startswith("CTOC"):
            del tags[key]

    child_ids = []
    for idx, chapter in enumerate(chapters):
        element_id = f"chp{idx:03d}"
        if chapter.get("toc", True):
            child_ids.append(element_id)

        sub_frames = [
            TIT2(encoding=3, text=chapter["title"]),
        ]

        image_path = chapter["image_path"]
        if image_path and os.path.isfile(image_path):
            with open(image_path, "rb") as imgf:
                img_data = imgf.read()
            sub_frames.append(
                APIC(
                    encoding=3,
                    mime=guess_mime(image_path),
                    type=3,
                    desc="chapter-image",
                    data=img_data,
                )
            )

        tags.add(
            CHAP(
                element_id=element_id,
                start_time=chapter["start_ms"],
                end_time=chapter["end_ms"],
                start_offset=0xFFFFFFFF,
                end_offset=0xFFFFFFFF,
                sub_frames=sub_frames,
            )
        )

    tags.add(
        CTOC(
            element_id="toc",
            flags=0x03,  # top-level + ordered
            child_element_ids=child_ids,
            sub_frames=[TIT2(encoding=3, text="Chapters")],
        )
    )

    tags.save(mp3_path, v2_version=3)


def main():
    parser = argparse.ArgumentParser(description="Embed chapter images into MP3 ID3 CHAP frames")
    parser.add_argument("--mp3", required=True)
    parser.add_argument("--chapters-json", required=True)
    args = parser.parse_args()

    if not os.path.isfile(args.mp3):
        fail(f"MP3 not found: {args.mp3}")

    chapters = read_chapters(args.chapters_json)
    if len(chapters) == 0:
        fail("No chapters provided")

    embed(args.mp3, chapters)
    print(f"Embedded chapter images for {len(chapters)} chapters into {args.mp3}")


if __name__ == "__main__":
    main()
