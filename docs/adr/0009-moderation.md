# 0009 — Refuse personal information synchronously; hold, never silently drop

**Status:** Accepted

## Context
A public forum for a billion people will carry doxxing, threats, abuse and spam. The platform's
privacy promises (no names, no phone numbers, per-topic pseudonyms) are worthless if a comment can
publish someone's Aadhaar number. At the same time, automatic moderation of Indian languages and
romanised text is error-prone, and a system that silently deletes speech it misreads loses trust
faster than one that is visibly slow.

## Decision
- **Personal information is refused before acceptance.** Aadhaar (with its Verhoeff checksum), PAN,
  Indian mobile numbers, email, UPI ids and labelled bank accounts are detected in the API; the
  author is told what kind of thing to remove, and the match itself is never echoed back. The worker
  repeats the check as a backstop, and a refused comment is stored with an empty body.
- **Everything else is published, held or rejected — never silently dropped.** Threats, abuse and
  spam signals *hold* a comment for review; it is invisible to others and visible to its author.
- **Reports hold a comment** when five distinct people report it (one report per pseudonym per
  comment), with the same answer to every reporter so coordinated reporting cannot tune itself.
- **Titles of local issues** are screened too, since they are public at once; a title that needs a
  look is created unlisted (`proposed`), not refused.

## What we gave up
- **This needs human moderators, and the console is not built.** Held comments wait; nothing
  releases them automatically. The queue, the reviewer tooling and the appeal path are on the
  roadmap.
- **Regex and lexicons miss things and catch things.** A phone number written in words passes; a
  long reference number shaped like one is refused. The large model (ADR-0011) is not used to
  moderate, only to label, because an automated verdict on speech should be explainable.
