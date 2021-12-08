import {
	FileMeta,
	FileMetaWithSideAndBase,
	GERRIT_FILE_SCHEME,
} from '../../../providers/fileProvider';
import {
	GerritCommentSide,
	GerritRevisionFile,
	GerritRevisionFileStatus,
} from './types';
import { DynamicallyFetchable } from './shared';
import { GerritChange } from './gerritChange';
import { Uri, workspace } from 'vscode';
import { GerritAPIWith } from './api';
import { getAPI } from '../gerritAPI';

export class TextContent {
	private constructor(public buffer: Buffer, public meta: FileMeta) {}

	public static from(
		meta: FileMeta,
		content: string,
		encoding: BufferEncoding
	): TextContent {
		return new TextContent(Buffer.from(content, encoding), meta);
	}

	public getText(): string {
		return this.buffer.toString('utf8');
	}

	public toVirtualFile(
		forSide: GerritCommentSide | 'BOTH',
		baseRevision: number | null
	): Uri {
		return Uri.from({
			scheme: GERRIT_FILE_SCHEME,
			path: this.meta.filePath,
			query: FileMetaWithSideAndBase.fromFileMeta(
				this.meta,
				forSide,
				baseRevision
			).toString(),
		});
	}

	public isEmpty(): boolean {
		return this.meta.isEmpty();
	}
}

export class GerritFile extends DynamicallyFetchable {
	public linesInserted: number;
	public linesDeleted: number;
	public sizeDelta: number;
	public size: number;
	public status: GerritRevisionFileStatus | null;
	public oldPath: string | null;

	public constructor(
		public override changeID: string,
		public change: GerritChange,
		public currentRevision: string,
		public filePath: string,
		response: GerritRevisionFile
	) {
		super();
		this.linesInserted = response.lines_inserted;
		this.linesDeleted = response.lines_deleted;
		this.sizeDelta = response.size_delta;
		this.size = response.size;
		this.status = response.status ?? null;
		this.oldPath = response.old_path ?? null;
	}

	public async getNewContent(): Promise<TextContent | null> {
		return this.getContent(this.currentRevision);
	}

	public async getOldContent(): Promise<TextContent | null> {
		const api = await getAPI();
		if (!api) {
			return null;
		}

		const commit = await this.change.getCurrentCommit(
			GerritAPIWith.CURRENT_FILES
		);
		if (!commit) {
			return null;
		}

		return this.getContent(
			commit.parents[commit.parents.length - 1].commit,
			true
		);
	}

	public async getContent(
		revision: string = this.currentRevision,
		useOldPath = false
	): Promise<TextContent | null> {
		const filePath = useOldPath
			? this.oldPath ?? this.filePath
			: this.filePath;
		const api = await getAPI();
		if (!api) {
			return null;
		}

		const content = await api.getFileContent({
			project: this.change.project,
			commit: revision,
			changeID: this.change.id,
			filePath,
		});
		if (!content) {
			return null;
		}

		return content;
	}

	public getLocalURI(
		forSide: GerritCommentSide,
		forBaseRevision: number | null
	): Uri | null {
		if (
			!workspace.workspaceFolders ||
			workspace.workspaceFolders.length !== 1
		) {
			return null;
		}
		const workspaceFolder = workspace.workspaceFolders[0];
		const filePath = Uri.joinPath(workspaceFolder.uri, this.filePath);
		return filePath.with({
			query: FileMetaWithSideAndBase.createFileMetaWithSide(
				{
					project: this.change.project,
					commit: this.currentRevision,
					filePath: this.filePath,
					changeID: this.change.id,
				},
				forSide,
				forBaseRevision
			).toString(),
		});
	}

	public async isLocalFile(content: TextContent): Promise<boolean> {
		const filePath = this.getLocalURI(GerritCommentSide.LEFT, null);
		if (!filePath) {
			return false;
		}
		const stat = await (async () => {
			try {
				return await workspace.fs.stat(filePath);
			} catch (e) {
				return false;
			}
		})();
		if (!stat) {
			return false;
		}

		const fileContent = await workspace.fs.readFile(filePath);
		return (
			stat.size === content.buffer.length &&
			content.buffer.equals(fileContent)
		);
	}
}
