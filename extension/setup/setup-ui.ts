import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { ALTERA_DOWNLOADS, type InstallSummary, type LicenseOffer, type QuartusFiles, type RosettaCommand, type RosettaConsent, type SetupInteraction } from '../../runtime/setup';
import { showLicensePanel } from './license-panel';

/** The Setup questions as VS Code dialogs. Student words only; engineering detail goes to `log`. */
export class VsCodeSetupInteraction implements SetupInteraction {
    constructor(
        private readonly report: (message: string) => void,
        private readonly onLog: (line: string) => void,
    ) {}

    async confirmInstall(s: InstallSummary): Promise<boolean> {
        const lines = [`This will set up: ${s.items.join('; ')}.`, s.storageGB >= 1 ? `It uses about ${s.storageGB.toFixed(1)} GB on this computer once finished (have about ${s.requiredFreeGB} GB free).` : 'It needs very little space.'];
        if (s.needsInternet) lines.push('It needs an internet connection.');
        if (s.askedForAltera) lines.push('Later it asks you for two free files from Altera and to accept Altera\'s licence.');
        const pick = await vscode.window.showInformationMessage('Install FPGA Toolchain', { modal: true, detail: lines.join('\n') }, 'Continue');
        return pick === 'Continue';
    }

    async askRosettaConsent(): Promise<RosettaConsent | undefined> {
        const pick = await vscode.window.showInformationMessage(
            'Apple\'s Rosetta is needed',
            { modal: true, detail: 'The FPGA software runs through Rosetta, which comes from Apple. MIX-FPGA will open Apple\'s own installer in a terminal. Apple shows its licence there and asks you to agree and to enter your Mac password. MIX-FPGA does not see either.' },
            'Open Apple\'s Installer',
        );
        return pick ? { method: 'apple-prompt' } : undefined;
    }

    async askQuartusFiles(): Promise<QuartusFiles | undefined> {
        const wanted = [ALTERA_DOWNLOADS.installerName, ALTERA_DOWNLOADS.packageName];
        const downloads = join(homedir(), 'Downloads');
        const have = await readdir(downloads).catch(() => [] as string[]);
        if (wanted.every((n) => have.includes(n))) {
            const use = await vscode.window.showInformationMessage('Altera\'s files found', { modal: true, detail: `Use ${wanted.join(' and ')} from your Downloads folder? MIX-FPGA only reads them; it does not change or move them.` }, 'Use These Files', 'Choose Other Files…');
            if (use === 'Use These Files') return { installerPath: join(downloads, wanted[0]!), devicePackagePath: join(downloads, wanted[1]!) };
            if (!use) return undefined;
        } else {
            const ok = await vscode.window.showInformationMessage(
                'Altera\'s free software is needed',
                { modal: true, detail: `Download these two files from Altera (Quartus Prime Lite ${ALTERA_DOWNLOADS.version}, Linux, with MAX 10 device support):\n\n${wanted.join('\n')}\n\nThen choose them here. MIX-FPGA does not download them for you.` },
                'Choose Files…',
            );
            if (!ok) return undefined;
        }
        const pick = (name: string, ext: string) =>
            vscode.window.showOpenDialog({ canSelectMany: false, canSelectFiles: true, canSelectFolders: false, defaultUri: vscode.Uri.file(downloads), openLabel: 'Use This File', title: `Choose ${name}`, filters: { 'Altera download': [ext] } }).then((r) => r?.[0]?.fsPath);
        const installer = await pick(wanted[0]!, 'run');
        if (!installer) return undefined;
        const pkg = await pick(wanted[1]!, 'qdz');
        return pkg ? { installerPath: installer, devicePackagePath: pkg } : undefined;
    }

    showLicense(offer: LicenseOffer): Promise<boolean> {
        return showLicensePanel(offer);
    }

    progress(message: string): void {
        this.report(message);
    }

    log(line: string): void {
        this.onLog(line);
    }
}

/** Runs Apple's installer where the student can see it and answer it. MIX-FPGA never types for them. */
export async function runRosettaInTerminal(command: RosettaCommand): Promise<{ exitCode: number | undefined; output: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'mixfpga-rosetta-'));
    const status = join(dir, 'status');
    const line = `sudo ${command.executable} ${command.args.join(' ')}`;
    const terminal = vscode.window.createTerminal({ name: 'Rosetta installer (Apple)', shellPath: '/bin/zsh', shellArgs: ['-c', `${line}; echo $? > '${status}'; echo; read -k 1 "?Finished. Press any key to close..."`] });
    terminal.show();
    await new Promise<void>((resolve) => {
        const sub = vscode.window.onDidCloseTerminal((t) => {
            if (t !== terminal) return;
            sub.dispose();
            resolve();
        });
    });
    const code = await readFile(status, 'utf8').then((t) => Number(t.trim()), () => undefined);
    await rm(dir, { recursive: true, force: true });
    return { exitCode: Number.isFinite(code) ? code : undefined, output: '' };
}
