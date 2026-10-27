// Generated from CHANGELOG.md by `npm run sync:changelog`. Don't edit.
export default [
  {
    "version": "0.1.0",
    "date": "2026-10-27",
    "prerelease": false,
    "summary": "First public release.",
    "sections": [
      {
        "title": "Added",
        "items": [
          {
            "text": "**Start screen:** every ready drive with bus and media type, file system, used/free space and a low-space warning. Folder picker, drag-and-drop anywhere, remembered scan options, and the last 8 scans saved for instant reopening.",
            "children": []
          },
          {
            "text": "**Scanner:**",
            "children": [
              "Multi-threaded folder walk with long-path support.",
              "**Fast scan** that reads the NTFS master file table directly (administrator rights), with an offer to restart elevated and resume.",
              "Optional hidden/system files, and junction and symlink following with loop protection."
            ]
          },
          {
            "text": "**Scanning screen:** live percentage, time estimate, counters, a map of top-level folders that fills in, and the biggest files so far. Pause, resume and cancel. *Explore partial results* while the scan continues, refreshed in place when it finishes. Progress also shows on the taskbar button.",
            "children": []
          },
          {
            "text": "**Explorer:**",
            "children": [
              "Treemap (cushion-shaded), sunburst and columns views with hover, select, zoom and a right-click menu.",
              "Breadcrumb, folder tree in sync with the map, file-type legend that can highlight a type, and a details panel with a mini-map for folders.",
              "Keyboard shortcuts."
            ]
          },
          {
            "text": "**Search** with name terms, globs, size filters and `type:`.",
            "children": []
          },
          {
            "text": "**Smart views:** largest files, content-verified duplicates, untouched for 1 year, caches & temp, dev artifacts.",
            "children": []
          },
          {
            "text": "**Cleanup review:**",
            "children": [
              "Categorised suggestions with reasons and Safe/Review badges, select-all, a live \"you'll free\" total and the drive after cleanup.",
              "Recycle Bin by default, or permanent deletion.",
              "Protected system locations, cache folders emptied rather than removed, and files in use reported."
            ]
          },
          {
            "text": "**History:** 7-day log of removals, with restore from the Recycle Bin.",
            "children": []
          },
          {
            "text": "**Settings:** accent color, cushion shading, restart as administrator, clear recent scans.",
            "children": []
          },
          {
            "text": "Windows installer (per-user) and a single-file portable version that keeps its data next to the `.exe`.",
            "children": []
          }
        ]
      }
    ]
  }
];
