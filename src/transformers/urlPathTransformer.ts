/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import {BasePathTransformer} from './basePathTransformer';

import {ISetBreakpointsArgs, ILaunchRequestArgs, IAttachRequestArgs, IStackTraceResponseBody} from '../debugAdapterInterfaces';
import * as utils from '../utils';
import {Logger as logger} from 'vscode-debugadapter';
import * as ChromeUtils from '../chrome/chromeUtils';
import {ChromeDebugAdapter} from '../chrome/chromeDebugAdapter';

import * as path from 'path';

/**
 * Converts a local path from Code to a path on the target.
 */
export class UrlPathTransformer extends BasePathTransformer {
    private _webRoot: string;
    private _pathMapping: {[url: string]: string} = {};
    private _clientPathToTargetUrl = new Map<string, string>();
    private _targetUrlToClientPath = new Map<string, string>();

    public launch(args: ILaunchRequestArgs): Promise<void> {
        this._webRoot = args.webRoot;
        this._pathMapping = args.pathMapping || {};
        return super.launch(args);
    }

    public attach(args: IAttachRequestArgs): Promise<void> {
        this._webRoot = args.webRoot;
        this._pathMapping = args.pathMapping || {};
        return super.attach(args);
    }

    public setBreakpoints(args: ISetBreakpointsArgs): void {
        if (!args.source.path) {
            // sourceReference script, nothing to do
            return;
        }

        if (utils.isURL(args.source.path)) {
            // already a url, use as-is
            logger.log(`Paths.setBP: ${args.source.path} is already a URL`);
            return;
        }

        const path = utils.canonicalizeUrl(args.source.path);
        const url = this.getTargetPathFromClientPath(path);
        if (url) {
            args.source.path = url;
            logger.log(`Paths.setBP: Resolved ${path} to ${args.source.path}`);
            return;
        } else {
            logger.log(`Paths.setBP: No target url cached yet for client path: ${path}.`);
            args.source.path = path;
            return;
        }
    }

    public clearTargetContext(): void {
        this._clientPathToTargetUrl = new Map<string, string>();
        this._targetUrlToClientPath = new Map<string, string>();
    }

    public scriptParsed(scriptUrl: string): string {
        let clientPath = ChromeUtils.targetUrlToClientPathByPathMappings(scriptUrl, this._pathMapping);

        if (!clientPath) {
            clientPath = ChromeUtils.targetUrlToClientPath(this._webRoot, scriptUrl);
        }

        if (!clientPath) {
            // It's expected that eval scripts (eval://) won't be resolved
            if (!scriptUrl.startsWith(ChromeDebugAdapter.EVAL_NAME_PREFIX)) {
                logger.log(`Paths.scriptParsed: could not resolve ${scriptUrl} to a file under webRoot: ${this._webRoot}. It may be external or served directly from the server's memory (and that's OK).`);
            }
        } else {
            logger.log(`Paths.scriptParsed: resolved ${scriptUrl} to ${clientPath}. webRoot: ${this._webRoot}`);
            this._clientPathToTargetUrl.set(clientPath, scriptUrl);
            this._targetUrlToClientPath.set(scriptUrl, clientPath);

            scriptUrl = clientPath;
        }

        return scriptUrl;
    }

    public stackTraceResponse(response: IStackTraceResponseBody): void {
        response.stackFrames.forEach(frame => {
            if (frame.source && frame.source.path) {
                // Try to resolve the url to a path in the workspace. If it's not in the workspace,
                // just use the script.url as-is. It will be resolved or cleared by the SourceMapTransformer.
                const clientPath = this.getClientPathFromTargetPath(frame.source.path) ||
                    ChromeUtils.targetUrlToClientPath(this._webRoot, frame.source.path);

                // Incoming stackFrames have sourceReference and path set. If the path was resolved to a file in the workspace,
                // clear the sourceReference since it's not needed.
                if (clientPath) {
                    frame.source.path = clientPath;
                    frame.source.sourceReference = undefined;
                    frame.source.origin = undefined;
                }
            }
        });
    }

    public getTargetPathFromClientPath(clientPath: string): string {
        // If it's already a URL, skip the Map
        return path.isAbsolute(clientPath) ?
            this._clientPathToTargetUrl.get(utils.canonicalizeUrl(clientPath)) :
            clientPath;
    }

    public getClientPathFromTargetPath(targetPath: string): string {
        return this._targetUrlToClientPath.get(targetPath);
    }
}
