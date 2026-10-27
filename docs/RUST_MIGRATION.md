# Plan : un seul scanner en Rust pour Windows et Linux

## Objectif

Aujourd'hui, Strata a **deux scanners** qui font la même chose :

| | Windows (`main`) | Linux (branche `claude/admiring-albattani-zy7g6e`) |
|---|---|---|
| Fichiers | `scanner/StrataScan.cs` (~1 660 lignes, C# 5) | `scanner/linux/strata-scan.js`, `mounts.js`, `trash.js` (~800 lignes) |
| Compilation | `csc.exe` du .NET Framework intégré à Windows | aucune, exécuté par le Node.js d'Electron (`ELECTRON_RUN_AS_NODE=1`) |
| Lancement par `main.js` | `spawn(StrataScan.exe, args)` | `spawn(process.execPath, [strata-scan.js, ...args])` |

Ce plan les remplace par **un seul binaire Rust, `strata-scan`**, compilé pour `x86_64-pc-windows-msvc` et `x86_64-unknown-linux-musl`. Il garde exactement :

- les **mêmes commandes** (`info`, `scan`, `dupes`, `delete`) ;
- les **mêmes messages JSON lines** sur stdout et les mêmes commandes stdin (`pause`, `resume`, `stop`, `snapshot <file>`) ;
- le **même fichier `.strata`** (`STRATA01`).

L'interface (`src/renderer/`) n'a rien à changer. `main.js` perd ses deux chemins de lancement et la gestion de la Corbeille ou de la Trash.

**Hors objectif :** réécrire l'interface ou le processus principal. Ils sont déjà en JavaScript multiplateforme via Electron.

---

## Ce qui est commun et ce qui reste propre à chaque OS

Rust ne fait pas disparaître les différences entre les systèmes. Il les **isole** dans deux petits modules derrière une interface commune.

| Partie | Commun (`core`) | Windows | Linux |
|---|---|---|---|
| Ligne de commande, protocole JSON, stdin | ✅ | | |
| Écriture du `.strata` (et lecture pour les tests) | ✅ | | |
| Types de fichiers (extensions → 9 catégories) | ✅ (une seule table, union des deux listes) | | |
| État du scan : compteurs, `tops`, `biggest`, `pct`, pause/stop/snapshot, ticker 180 ms | ✅ | | |
| Pool de threads et pile de dossiers (parcours en profondeur, parents avant enfants) | ✅ | | |
| Lister un dossier | trait `DirLister` | `FindFirstFileExW` (FIND_FIRST_EX_LARGE_FETCH, info basique), préfixe `\\?\` | `openat` + `getdents64` + `statx`/`fstatat` relatifs au dossier |
| Liens | trait `LinkPolicy` | jonctions et symlinks, cible via `GetFinalPathNameByHandleW` | symlinks, identité `(dev, inode)` |
| Taille comptée | | taille logique, 0 si placeholder cloud | taille allouée si plus petite (fichiers creux), hardlinks comptés une fois |
| Rester sur un seul volume | | (implicite) | ne pas traverser les points de montage |
| Fichier caché, système | | attributs `HIDDEN` / `SYSTEM` | nom commençant par `.` ; pas de « système » |
| Scan rapide | | **lecteur MFT NTFS** (admin) | `--mft` accepté et ignoré |
| `info` (disques) | struct `Drive` commune | `GetLogicalDrives` + `GetVolumeInformationW` + `GetDiskFreeSpaceExW` ; bus et SSD/HDD par `IOCTL_STORAGE_QUERY_PROPERTY` | `/proc/self/mountinfo`, `statfs`, `/sys/class/block`, `/dev/disk/by-label` |
| Admin | | jeton élevé (`GetTokenInformation` / `TokenElevation`) | `geteuid() == 0` |
| Doublons (échantillons début, milieu et fin, puis hash complet ≤ 1 Go) | ✅ | | |
| Suppression définitive (liens supprimés, jamais suivis) | ✅ (`std::fs` + `symlink_metadata`) | retrait de l'attribut lecture seule | |
| Corbeille / Trash | trait `Trash` | `SHFileOperationW` par lots de 64, mêmes flags (avec `FOF_WANTNUKEWARNING`) | freedesktop.org : Trash du dossier personnel ou `$topdir/.Trash[-$uid]`, `.trashinfo` écrit d'abord |
| Lister la corbeille, restaurer | trait `Trash` | fichiers `$I` / `$R` de `$Recycle.Bin` | fichiers `.trashinfo` |

Structure du code :

```
scanner/
  Cargo.toml
  src/
    main.rs              # répartition des commandes, codes de sortie, erreur JSON finale
    protocol.rs          # messages (serde), sortie stdout verrouillée, lecture stdin
    types.rs             # extensions -> catégorie (partagé avec src/renderer/lib/types.js)
    strata_file.rs       # écriture atomique (.part puis renommage) + lecture pour les tests
    scan/
      mod.rs             # commande scan : options, choix MFT ou parcours, en-tête, done
      state.rs           # ScanState, TopItem, biggest, pct, ticker
      walker.rs          # pool de threads générique sur DirLister + LinkPolicy
    dupes.rs
    delete.rs            # boucle commune, messages progress/result/done
    platform/
      mod.rs             # traits DirLister, LinkPolicy, Trash, fonctions drives()/is_admin()
      windows/
        mod.rs  list.rs  links.rs  info.rs  recycle.rs  mft/{mod.rs, boot.rs, record.rs, runs.rs, tree.rs}
      linux/
        mod.rs  list.rs  links.rs  info.rs  mounts.rs  trash.rs
  tests/
    fixtures/            # petit volume NTFS compressé + arbre attendu (voir phase 5)
```

### Dépendances (crates)

| Crate | Pour quoi |
|---|---|
| `serde`, `serde_json` | messages JSON (mêmes noms de champs qu'aujourd'hui) |
| `crossbeam-channel` ou `std::sync` | pile de travaux et pool de threads |
| `md-5` | hash des doublons. Le hash n'est jamais exposé, donc `blake3` (plus rapide) reste possible si l'on garde la même logique d'échantillonnage. |
| `windows` (officielle Microsoft) | `Win32_Storage_FileSystem`, `Win32_UI_Shell`, `Win32_System_Ioctl`, `Win32_Security` |
| `rustix` (ou `libc`) | `openat`, `getdents`, `statx`, `statfs`, `geteuid` sur Linux |
| `mimalloc` | allocateur rapide en multithread (le `malloc` de musl est lent) |
| `percent-encoding` | chemins des `.trashinfo` |
| `tempfile` (dev) | tests |

**Pas de crate `trash` pour Windows.** Selon les flags qu'elle utilise, un élément trop gros pour la Corbeille peut être supprimé définitivement sans avertissement. On porte donc à l'identique l'appel `SHFileOperationW` actuel, qui garde `FOF_WANTNUKEWARNING`. Sur Linux, on porte `trash.js` (120 lignes), qui gère déjà les cas particuliers (Trash personnelle encore inexistante, `topdir`).

---

## Contrat à respecter (référence pour les tests)

Avant d'écrire du Rust, on fige le contrat dans `docs/PROTOCOL.md`, à partir des deux implémentations actuelles.

**Commandes**

- `info` → `{"type":"info","admin":bool,"drives":[{letter, root, label, fs, total, free, kind, bus, media, cluster, system}]}`. Sur Linux, `letter` vaut `null` (en plus : `mount`, `removable`… selon `mounts.js`).
- `scan <path> <out> [--mft] [--hidden] [--links]` →
  - `progress` : `phase` (`walk` | `mft` | `build` | `paused`), `files`, `dirs`, `bytes`, `errors`, `pct`, `current`, `tops[{name, dir, bytes, state, type}]`, `biggest[{path, size, type}]`, à peu près toutes les 180 ms ;
  - `notice {message}` (repli MFT → parcours normal) ;
  - `snapshot {out}` ou `snapshot {error}` ;
  - pour finir, `done {out, partial, method}` ou `error {message}`.
- `dupes <list>` (lignes `size\tpath` regroupées par taille) → `progress {done, total}`, `group {size, verified, paths}`, `done`. Limite de 240 s ; hash complet jusqu'à 1 Go, échantillons au-delà.
- `delete <list> [recycle|permanent]` → `progress {done, total, current}`, `result {path, ok, remaining, error}`, `done`.
- **Nouvelles (phase 6)** :
  - `trash-list <path>` → `{type:"entry", original, deletedAt, location}` pour chaque élément ;
  - `restore <list>` → `result`, puis `done`.

**Fichier `.strata`** : voir `docs/ARCHITECTURE.md`. En-tête JSON : `version`, `root`, `fs`, `cluster`, `total`, `free`, `method`, `scannedAt` (ms), `duration` (s, 1 décimale), `partial`, `files`, `dirs` (sans la racine), `errors`, `bytes`, `options{mft, hidden, links}`. Le parent d'un nœud a toujours un indice plus petit que le sien.

**Codes de sortie** : 0 succès, 1 erreur, 2 commande manquante ou inconnue.

---

## Phases

Chaque phase donne une PR qui laisse l'appli fonctionnelle. Les anciens scanners restent en place jusqu'à la phase 7 et servent de **référence** dans les tests de comparaison.

### Phase 0 — Préparer le terrain

1. Fusionner la branche Linux (`claude/admiring-albattani-zy7g6e`) dans `main`. Le plan part de l'état « Windows + Linux qui marchent » : `lib/platform.js`, packaging Linux et `test-scanner.js` existent déjà.
2. Écrire `docs/PROTOCOL.md` (contrat ci-dessus, avec un exemple de chaque message).
3. Ajouter `scripts/compare-scans.js` : lit deux `.strata`, construit `chemin → {size, flags, type, mtime}` et affiche les différences.
   - Tolérances : `mtime` à ±1 s ; ordre des enfants libre.
   - Ignorés dans l'en-tête : `duration`, `scannedAt`, `method`, `free`.
4. Rendre `scripts/test-scanner.js` indépendant de l'OS : le chemin du scanner est passé en paramètre, les attentes propres à chaque plateforme (casse, `letter`, Trash ou Corbeille) sont isolées. Le faire tourner sur Windows aussi, contre `StrataScan.exe`.

**Fin de phase :** les tests existants passent sur les deux OS contre les anciens scanners. On a un contrat écrit et un outil de comparaison.

### Phase 1 — Squelette Rust et cœur commun

1. Créer `scanner/Cargo.toml` (édition 2024) avec le profil release `lto = "fat"`, `codegen-units = 1`, `panic = "abort"`, `strip = true`.
2. `scanner/.cargo/config.toml` : `+crt-static` pour MSVC (pas besoin du redistribuable VC++).
3. Écrire `main.rs`, `protocol.rs`, `types.rs` (union des deux tables, y compris `appimage`, `flatpak`, `deb`, `rpm`, `snap`, `*.so.N`) et `strata_file.rs`.
4. Commande `info` sur les deux OS.
5. Tests unitaires :
   - échappement JSON (caractères de contrôle, guillemets, chemins Windows) ;
   - aller-retour d'écriture et lecture du `.strata` (alignement à 8 octets, noms UTF-8 avec NUL) ;
   - classement des extensions (comparé à `src/renderer/lib/types.js` : un test lit le fichier JS et vérifie que les listes sont identiques).
6. `scripts/build-scanner.js` :
   - lance `cargo build --release --manifest-path scanner/Cargo.toml --target <triple>` ;
   - copie le binaire dans `bin/strata-scan[.exe]` ;
   - garde `--if-missing`, en comparant les dates de `scanner/src/**` et `Cargo.lock`.

**Fin de phase :** `strata-scan info` donne la même liste de disques que l'ancien scanner (comparaison automatique en CI, aux champs dynamiques près).

### Phase 2 — Scan en parcours de dossiers, Linux

1. Écrire `walker.rs` générique : pool de `clamp(nb_cpu, 2, 8)` threads, pile LIFO partagée (parcours en profondeur, même ordre que le C# et le JS), compteur `outstanding`, pause par `Condvar`, stop qui vide la pile.
   - Les nœuds sont ajoutés en bloc par dossier sous un verrou, comme aujourd'hui, pour que le parent passe toujours avant ses enfants.
2. `state.rs` : `tops` (état pending/active/done, octets par type, type dominant), `biggest` (5 fichiers > 64 Mo), `pct` (octets / espace utilisé pour une racine de disque, sinon `tops` terminés + 0,45 × actifs), ticker toutes les 180 ms, `snapshot` dans un thread à part (copie des nœuds).
3. `platform/linux` :
   - `list.rs` : `openat(dirfd, O_DIRECTORY)` + `getdents64` + `statx(AT_SYMLINK_NOFOLLOW)` relatif au descripteur. Ça évite de reconstruire les chemins et c'est plus rapide que `readdir` + `lstat`.
   - Hardlinks : un ensemble `(dev, ino)` pour les fichiers dont `nlink > 1`.
   - Fichiers creux : `min(size, blocks × 512)`.
   - Ne pas descendre quand `dev` est différent de celui de la racine (sauf pour une cible de lien quand `--links` est actif).
   - `links.rs` : suivi des symlinks avec un ensemble `(dev, ino)` des dossiers déjà visités.
   - `mounts.rs` : port de `mounts.js` (pseudo-systèmes de fichiers, réseau, préfixes masqués, `/run/media`, décodage octal de mountinfo).
4. Erreurs : `EACCES` et `EPERM` → flag `Denied` + `errors++` ; `ENOENT` en cours de route → ignoré.

**Fin de phase :**
- `compare-scans.js` ne trouve aucune différence entre l'ancien scanner JS et `strata-scan` sur : un arbre de test généré (liens, hardlinks, fichiers creux, noms non UTF-8, permissions refusées, montage tmpfs imbriqué), `/usr` et le dossier personnel du runner CI.
- Benchmark : au moins aussi rapide que le JS sur un arbre de 200 000 fichiers.

### Phase 3 — Scan en parcours de dossiers, Windows

1. `platform/windows/list.rs` :
   - `FindFirstFileExW(FindExInfoBasic, FIND_FIRST_EX_LARGE_FETCH)` ;
   - préfixe `\\?\` / `\\?\UNC\` au-delà de 240 caractères ;
   - erreurs 2 et 18 (`ERROR_FILE_NOT_FOUND`, `ERROR_NO_MORE_FILES`) → dossier vide, les autres → `Denied` ;
   - placeholders cloud (`RECALL_ON_DATA_ACCESS | RECALL_ON_OPEN | OFFLINE`) → taille 0 + flag `Cloud`.
2. `links.rs` :
   - `CreateFileW(FILE_FLAG_BACKUP_SEMANTICS)` + `GetFinalPathNameByHandleW` ;
   - refus si la cible est un ancêtre ;
   - ensemble des cibles insensible à la casse ;
   - profondeur ≤ 64.
3. `info.rs` :
   - remplacer WMI (`MSFT_PhysicalDisk`) par `IOCTL_STORAGE_QUERY_PROPERTY` : `StorageDeviceProperty` pour `BusType`, `StorageDeviceSeekPenaltyProperty` pour SSD/HDD. C'est plus léger que WMI, sans COM ;
   - même table `BusName`, CD-ROM exclus, `system` = disque de `%SystemRoot%`.
4. Chemins : travailler en `Vec<u16>` / `OsString` côté Windows et ne convertir en UTF-8 qu'à l'écriture. Les noms invalides (surrogates isolés) sont convertis avec perte, comme le C# aujourd'hui.

**Fin de phase :** sur le runner `windows-latest`, aucune différence entre `StrataScan.exe` (compilé par `csc` dans la CI) et `strata-scan.exe` en mode parcours. Tests sur :
- un arbre généré avec jonctions, symlinks, chemins de plus de 260 caractères, attributs caché et système, fichiers en lecture seule ;
- `C:\Windows\System32` (en lecture seule).

### Phase 4 — Doublons et suppression

1. `dupes.rs` : même algorithme.
   - Groupes triés par gain potentiel `size × (n − 1)`.
   - Hash d'échantillons de 64 Ko au début, au milieu et à la fin.
   - Puis hash complet si ≤ 1 Go, sinon `verified: false`.
   - `progress` toutes les 250 ms, arrêt à 240 s.
   - Ouverture en partage lecture, écriture et suppression sous Windows.
   - Bonus possible, sans changer le résultat : hasher les fichiers d'un même groupe en parallèle.
2. `delete.rs` : boucle commune (progress, existence, taille restante, message d'erreur).
   - Définitif : récursif avec `symlink_metadata`, liens et jonctions supprimés sans être suivis, attribut lecture seule retiré sous Windows.
   - Corbeille Windows : `SHFileOperationW` par lots de 64, puis nouvel essai élément par élément, avec les mêmes flags ; « Path too long for the Recycle Bin » au-delà de 260 caractères.
   - Trash Linux : port de `trash.js`, `.trashinfo` écrit avant le déplacement, noms uniques, `$topdir/.Trash/$uid` (sticky, pas un lien) puis `$topdir/.Trash-$uid`.

**Fin de phase :** les tests de `test-scanner.js` pour `dupes` et `delete` passent sur les deux OS contre `strata-scan`. Sous Windows, un test vérifie qu'un fichier envoyé à la Corbeille y apparaît bien (fichier `$I`).

### Phase 5 — Lecteur MFT (Windows)

Partie la plus délicate. Elle est faite **en dernier**, quand tout le reste est validé.

1. Découper le code :
   - `boot.rs` : secteur de boot (taille de cluster, de secteur, d'enregistrement, LCN de la MFT) ;
   - `runs.rs` : data runs ;
   - `record.rs` : signature `FILE`, correctifs d'update sequence, attributs `$STANDARD_INFORMATION`, `$FILE_NAME` (Win32 prioritaire sur le nom DOS), `$DATA` non nommé, `$ATTRIBUTE_LIST` et enregistrements d'extension ;
   - `tree.rs` : liens parent → enfants, parcours en profondeur depuis la racine ou le dossier scanné, résolution progressive des `tops` pour la carte en direct, snapshot pendant la lecture.
2. **Toute la lecture passe par un trait `VolumeReader: Read + Seek`.**
   - En production : `CreateFileW("\\.\C:")`, lectures alignées sur le secteur par blocs de 1 Mo.
   - En test : un **fichier image**. Le parseur devient testable sur n'importe quel OS, y compris dans la CI Linux.
3. Fixtures :
   - Un petit volume NTFS de 16 Mo, créé une fois sous Windows (VHD) avec un contenu connu : fichiers fragmentés, `$ATTRIBUTE_LIST`, noms longs et 8.3, hardlinks, dossiers profonds, fichiers creux et compressés, ADS.
   - Compressé en zstd (quelques centaines de Ko) dans `scanner/tests/fixtures/`, avec l'arbre attendu en JSON.
   - Variante générée en CI Linux avec `mkntfs` + `ntfscp` (paquet `ntfs-3g`) pour les cas simples.
4. Fuzzing (`cargo fuzz`) du parseur d'enregistrements : un enregistrement corrompu doit donner une erreur, puis un `notice` et le repli sur le parcours, jamais un plantage.
5. Repli identique à aujourd'hui : pas NTFS, pas admin, accès refusé ou structure inattendue → `notice` avec le même message, compteurs remis à zéro, parcours normal.

**Fin de phase :**
- Tests sur fixtures OK sur les deux OS.
- Sur `windows-latest` (les runners tournent en admin, `C:` est en NTFS), un même dossier donne un arbre identique en `--mft` et en parcours, et identique à l'ancien `StrataScan.exe --mft`.
- Benchmark : scan MFT de `C:` sur le runner au moins aussi rapide que le C#.

### Phase 6 — Brancher sur l'appli

1. `src/main/main.js` :
   - un seul `SCANNER = path.join(app.isPackaged ? process.resourcesPath : ROOT/bin, 'strata-scan' + (IS_WIN ? '.exe' : ''))` ;
   - un seul `spawn(SCANNER, args, { windowsHide: true })` ;
   - suppression du chemin `ELECTRON_RUN_AS_NODE`.
2. Déplacer la logique propre à chaque OS de `main.js` vers le scanner :
   - `recycleEntries()` (lecture des `$I`) et `trash.trashEntries()` → commande `trash-list` ;
   - le déplacement `$R` → original et la restauration Linux → commande `restore` ;
   - `trash.homeTrash()` (chemins protégés) → champ `trashDirs` dans la réponse d'`info`.
3. Regrouper les `IS_WIN ? … : …` restants de `main.js` (chemins protégés, libellés de menu, relance en admin) dans `src/main/platform.js`, sur le modèle de `src/renderer/lib/platform.js`.
4. `package.json` / electron-builder :
   - `win.extraResources` → `bin/strata-scan.exe` ;
   - `linux.extraResources` → `bin/strata-scan` (mode 755) ;
   - suppression de l'entrée `scanner/linux/*.js` ;
   - `pack`, `dist`, `pack:linux` et `dist:linux` lancent `build-scanner.js`.
5. CI (`.github/workflows/build.yml`), sur les deux jobs :
   - `dtolnay/rust-toolchain@stable` (cibles `x86_64-pc-windows-msvc` et `x86_64-unknown-linux-musl`, avec `musl-tools` sur Ubuntu) + `Swatinem/rust-cache` ;
   - `cargo fmt --check`, `cargo clippy -- -D warnings`, `cargo test` ;
   - `npm run test:scanner` contre le binaire Rust ;
   - comparaison avec l'ancien scanner (jusqu'à la phase 7) ;
   - `npm run dist` ou `dist:linux`.
6. Docs :
   - `README.md` : prérequis de compilation (`rustup`, et les Build Tools MSVC sous Windows) ;
   - `CONTRIBUTING.md` ;
   - `docs/ARCHITECTURE.md` : un seul scanner, avec un schéma `core` / `platform`.

**Fin de phase :** l'appli packagée (NSIS, portable, AppImage, deb, rpm, pacman, tar.gz) fonctionne avec le binaire Rust. Vérification manuelle sur Windows 10, Windows 11, Ubuntu 24.04, Fedora et Arch : scan, scan rapide, pause, snapshot, doublons, Corbeille ou Trash, restauration.

### Phase 7 — Nettoyage et sortie

1. Une version bêta (`0.2.0-beta`) avec les deux anciens scanners encore dans le dépôt, mais plus utilisés.
2. Après retours, supprimer `scanner/StrataScan.cs` et `scanner/linux/`, puis la partie `csc` de `build-scanner.js` et la comparaison avec l'ancien scanner en CI. On garde les fixtures et les tests Rust.
3. Mettre à jour `CHANGELOG.md` et publier la `0.2.0`.

---

## Points d'attention

| Risque | Mesure |
|---|---|
| Régression silencieuse du lecteur MFT | fixtures, fuzzing, comparaison MFT / parcours / ancien C# en CI sur un vrai `C:` |
| Écarts de résultats entre l'ancien et le nouveau scanner | `compare-scans.js` en CI à chaque phase, rien n'est supprimé avant la phase 7 |
| Suppression définitive par erreur au lieu de la Corbeille | port exact de `SHFileOperationW` + `FOF_WANTNUKEWARNING`, pas de crate générique, test Corbeille en CI |
| Binaire Linux incompatible avec certaines distributions (glibc) | cible **musl**, binaire statique ; `mimalloc` pour compenser le `malloc` de musl |
| DLL VC++ manquante sous Windows | `+crt-static` |
| Antivirus / SmartScreen sur un nouvel exécutable non signé | même situation qu'aujourd'hui ; prévoir la signature de code plus tard |
| Prérequis pour les contributeurs (Rust + MSVC) | documenté ; `npm start` affiche un message clair si `cargo` est absent |
| Noms de fichiers non UTF-8 (Linux) ou surrogates isolés (Windows) | conversion avec perte à l'écriture, comme aujourd'hui ; test dédié |

## Ensuite (hors plan)

- **ARM64** : `aarch64-pc-windows-msvc` et `aarch64-unknown-linux-musl`, c'est surtout de la CI.
- **macOS** : la structure le permet. Il faudrait un module `platform/macos` (`getattrlistbulk`, Trash via `NSFileManager`) et une cible electron-builder.
- **MFT sous Linux** : grâce au trait `VolumeReader`, le lecteur NTFS pourrait scanner une partition NTFS (`/dev/sdXn`) en root sur Linux.

## Estimation

Environ 3 000 lignes de Rust, dont un tiers pour le lecteur MFT et ses tests. Sept PR, une par phase. Les phases 2 et 3 peuvent avancer en parallèle une fois la phase 1 terminée.
