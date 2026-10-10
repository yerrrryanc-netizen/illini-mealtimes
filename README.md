# Illini Mealtimes

**Open the app: https://yerrrryanc-netizen.github.io/illini-mealtimes/**

Fits breakfast, lunch, and dinner into the gaps in a UIUC class schedule, at whichever dining hall adds the least walking between classes, with each hall's daily menu.

This repository only hosts the built website. `site/` is the app, and a scheduled GitHub Action downloads University Housing's dining menus every morning (`scripts/fetch-menus.mjs`) and republishes it. Your schedule and preferences are stored only in your own browser.
