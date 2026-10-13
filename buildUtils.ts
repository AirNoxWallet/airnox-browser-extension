import * as chokidar from 'chokidar';
import { build, BuildOptions, context, LogLevel } from 'esbuild';
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { manifestFor } from './manifest_build';

export type Browser = 'firefox' | 'chrome';

export interface BuilderOptions {
  watchFlag: boolean;
  devFlag: boolean;
  chromeFlag: boolean;
  firefoxFlag: boolean;
  // Where the per-browser trees go; `dist` unless a caller (a test) needs a
  // tree of its own.
  distRoot?: string;
  logLevel?: LogLevel;
}

// The sha256 of a built tree: one line per file, `<sha256 of the file>
// <path relative to the tree>`, sorted by path, hashed again. It names the
// package's content, not the zip around it (a zip carries timestamps), so a
// reviewer who rebuilds from the same source and lockfile gets the same value.
export async function treeDigest(dir: string): Promise<string> {
  const files: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    const entries = await fs.readdir(path.join(dir, rel), {
      withFileTypes: true,
    });
    for (const entry of entries) {
      const child = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) await walk(child);
      else files.push(child);
    }
  };
  await walk('');
  files.sort();
  const lines: string[] = [];
  for (const file of files) {
    const bytes = await fs.readFile(path.join(dir, file));
    lines.push(
      `${createHash('sha256').update(bytes).digest('hex')}  ${file}\n`
    );
  }
  return createHash('sha256').update(lines.join('')).digest('hex');
}

export class Builder {
  watchFlag: boolean;
  devFlag: boolean;
  chromeFlag: boolean;
  firefoxFlag: boolean;
  distRoot: string;
  logLevel: LogLevel;
  buildFiles: string[];
  staticFiles: string[];
  staticDirs: string[];

  constructor(option: BuilderOptions) {
    this.watchFlag = option.watchFlag;
    this.devFlag = option.devFlag;
    this.chromeFlag = option.chromeFlag;
    this.firefoxFlag = option.firefoxFlag;
    this.distRoot = option.distRoot ?? 'dist';
    this.logLevel = option.logLevel ?? (option.watchFlag ? 'info' : 'warning');
    this.buildFiles = [];
    this.staticFiles = [];
    this.staticDirs = [];
  }

  addBuildFile(file: string) {
    this.buildFiles.push(file);
  }

  addStaticFile(file: string) {
    this.staticFiles.push(file);
  }

  addStaticDir(dir: string) {
    this.staticDirs.push(dir);
  }

  distDir(targetBrowser: Browser): string {
    switch (targetBrowser) {
      case 'firefox':
        return path.join(this.distRoot, 'dist-firefox');
      case 'chrome':
        return path.join(this.distRoot, 'dist-chrome');
    }
  }

  distPath(relPath: string, targetBrowser: Browser): string {
    return path.join(this.distDir(targetBrowser), relPath);
  }

  entryOptions(file: string, targetBrowser: Browser): BuildOptions {
    return {
      entryPoints: [file],
      bundle: true,
      outdir: this.distPath(path.dirname(file), targetBrowser),
      // The syntax level the bundles have always been lowered to; stated here
      // because esbuild no longer takes it from tsconfig.json.
      target: 'es2020',
      sourcemap: this.devFlag ? 'inline' : false,
      define: {
        'process.env.NODE_ENV': this.devFlag ? '"development"' : '"production"',
      },
      logLevel: this.logLevel,
    };
  }

  async bundle(file: string, targetBrowser: Browser): Promise<void> {
    const options = this.entryOptions(file, targetBrowser);
    if (this.watchFlag) {
      const ctx = await context(options);
      await ctx.watch();
    } else {
      await build(options);
    }
  }

  // Watch mode only: re-run `action` on every change under `paths` after the
  // first, awaited build. A failed re-run is reported and the watch goes on.
  watch(paths: string[], action: (changed: string) => Promise<void>) {
    chokidar
      .watch(paths, { ignoreInitial: true })
      .on('all', (event, changed) => {
        if (event !== 'add' && event !== 'change') return;
        console.log(event, changed);
        action(changed).catch((error: unknown) => {
          console.error(`watch: ${changed}:`, error);
        });
      });
  }

  async copyStaticFile(file: string, targetBrowser: Browser): Promise<void> {
    await fs.mkdir(this.distPath(path.dirname(file), targetBrowser), {
      recursive: true,
    });
    await fs.copyFile(file, this.distPath(file, targetBrowser));
    if (this.watchFlag) {
      this.watch([file], () =>
        fs.copyFile(file, this.distPath(file, targetBrowser))
      );
    }
  }

  async copyStaticDir(dir: string, targetBrowser: Browser): Promise<void> {
    await fs.cp(dir, this.distPath(dir, targetBrowser), { recursive: true });
    if (this.watchFlag) {
      this.watch([dir], (changed) =>
        fs.copyFile(
          changed,
          this.distPath(path.relative('.', changed), targetBrowser)
        )
      );
    }
  }

  async writeManifest(targetBrowser: Browser): Promise<void> {
    const baseManifestJson = JSON.parse(
      await fs.readFile('manifest.json', 'utf8')
    ) as Record<string, unknown>;
    const firefoxJson = JSON.parse(
      await fs.readFile('firefox.json', 'utf8')
    ) as Record<string, unknown>;
    // dist-chrome is the Chromium package (Chrome, Brave, Opera).
    const manifestJson = manifestFor(
      targetBrowser,
      baseManifestJson,
      firefoxJson
    );
    await fs.writeFile(
      this.distPath('manifest.json', targetBrowser),
      JSON.stringify(manifestJson, null, 1)
    );
  }

  async buildForBrowser(targetBrowser: Browser): Promise<void> {
    // Each build starts from an empty tree: a file an earlier build wrote and
    // this one does not would otherwise ship in the package.
    const dir = this.distDir(targetBrowser);
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(dir, { recursive: true });
    await Promise.all([
      ...this.buildFiles.map((file) => this.bundle(file, targetBrowser)),
      ...this.staticFiles.map((file) =>
        this.copyStaticFile(file, targetBrowser)
      ),
      ...this.staticDirs.map((d) => this.copyStaticDir(d, targetBrowser)),
      this.writeManifest(targetBrowser),
    ]);
    if (this.watchFlag) {
      this.watch(['manifest.json', 'firefox.json'], () =>
        this.writeManifest(targetBrowser)
      );
    }
  }

  // Resolves once every target is written, and rejects on the first failed
  // step, so a broken build ends the process with an error instead of leaving
  // a partial tree behind a zero exit code.
  async build(): Promise<void> {
    const targets: Browser[] = [];
    if (this.chromeFlag) targets.push('chrome');
    if (this.firefoxFlag) targets.push('firefox');
    for (const targetBrowser of targets) {
      await this.buildForBrowser(targetBrowser);
      if (!this.watchFlag && this.logLevel !== 'silent') {
        const dir = this.distDir(targetBrowser);
        console.log(`sha256 ${await treeDigest(dir)}  ${dir}`);
      }
    }
  }
}
