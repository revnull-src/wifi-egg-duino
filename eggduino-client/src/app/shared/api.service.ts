import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import {
    ignoreElements, switchMap, scan, catchError,
    shareReplay, distinctUntilChanged, skip, map, debounce
} from 'rxjs/operators';
import { Subject, concat, defer, EMPTY, of, merge, timer, race } from 'rxjs';
import { propsEqual, cache } from '../utils';
import { LayerResolveType } from '../create/services/svg-segmenter';
import { PresentationService } from './presentation.service';

const DEFAULT_CONFIG: Config = {
    hScale: 1,
    vScale: 1,
    vOffset: 0,

    optimizeTravel: true,
    reverseSegments: true,

    simplifySegments: true,
    simplifyThreshold: .04,

    layerResolveType: 'none',

    mergeSegments: true,
    minTravelDistance: .11,
};

@Injectable()
export class ApiService {
    private updateConfig$ = new Subject<Config>();
    private events$ = new Subject<
        { type: 'delete', name: string } |
        { type: 'create', name: string }
    >();

    private configInternal = concat(
        this.client.get<Config>('api/config').pipe(catchError(_ => of(DEFAULT_CONFIG))),
        this.updateConfig$,
    ).pipe(
        map(config => ({ ...DEFAULT_CONFIG, ...config })),
        shareReplay(1),
    );

    private saveConfig$ = this.configInternal.pipe(
        map((value, index) => ({ value, index })),
        debounce(({ index }) => index === 0 ? EMPTY : timer(5000)),
        map(({ value }) => value),
        distinctUntilChanged((a, b) => propsEqual(a, b)),
        skip(1),
        switchMap(config => this.client.post('api/config', config)),
        ignoreElements(),
    );

    readonly config$ = merge(this.configInternal, this.saveConfig$).pipe(shareReplay(1));

    readonly files$ = race(
        this.client.get<PrintFile[]>('api/files'),
        this.presentationService.globalLoader,
    ).pipe(
        switchMap(files => concat(
            of(files),
            this.events$.pipe(
                scan((ctx, event) => {
                    switch (event.type) {
                        case 'delete':
                            return ctx.filter(f => f.name !== event.name);
                        case 'create':
                            return [...ctx, { name: event.name }];
                        default:
                            throw new Error(`unsupported event`);
                    }
                }, files)
            ))
        ),
        shareReplay(1),
    );

    readonly motionParams$ = race(
        this.client.get<MotionParams>('api/motion'),
        this.presentationService.globalLoader,
    );

    constructor(
        private client: HttpClient,
        private presentationService: PresentationService,
    ) {
    }

    uploadFile(name: string, content: string) {
        const params: FormData = new FormData();
        params.append('data', new Blob([content], { type: 'text/plain' }), name);
        return race(
            concat(
                this.client.post('api/file', params),
                defer(() => {
                    this.events$.next({ type: 'create', name });
                }),
            ),
            this.presentationService.globalLoader,
        ).pipe(ignoreElements());
    }

    loadFile(name: string) {
        return race(
            this.client.get('api/file/' + name, {
                responseType: 'text'
            }).pipe(
                cache(this.getCacheKey(name)),
            ),
            this.presentationService.globalLoader
        );
    }

    deleteFile(name: string) {
        return race(
            concat(
                this.client.delete('api/file/' + name, {
                    responseType: 'text',
                }),
                defer(() => {
                    this.events$.next({ type: 'delete', name });
                    sessionStorage.removeItem(this.getCacheKey(name));
                    return EMPTY;
                }),
            ),
            this.presentationService.globalLoader
        ).pipe(ignoreElements());
    }

    printFile(name: string) {
        return race(
            this.client.post('api/print/' + name, '', { responseType: 'text' }),
            this.presentationService.globalLoader
        );
    }


    updateConfig(config: Config) {
        this.updateConfig$.next(config);
    }

    sendCommand(cmd: MotionCommand) {
        return race(
            this.client.post(
                'api/command',
                `command=${cmd}`,
                {
                    headers: new HttpHeaders().append('Content-Type', 'application/x-www-form-urlencoded'),
                }
            ),
            this.presentationService.globalLoader,
        ).pipe(ignoreElements());
    }

    updateMotionParams(params: MotionParams) {
        const url = new URLSearchParams();
        for (const [key, value] of Object.entries(params)) {
            url.append(key, `${value}`);
        }
        return race(
            this.client.patch('api/motion', url.toString(), {
                responseType: 'text',
                headers: new HttpHeaders().append('Content-Type', 'application/x-www-form-urlencoded'),
            }),
            this.presentationService.globalLoader,
        ).pipe(ignoreElements());
    }

    wifiScan() {
        return this.client.get<Network[]>('api/wifi/scan');
    }

    wifiStatus() {
        return this.client.get<WiFiStatus>('api/wifi');
    }

    wifiConnect(params: { ssid: string, bssid: string, password: string }) {
        const url = new URLSearchParams();
        for (const [key, value] of Object.entries(params)) {
            url.append(key, `${value}`);
        }
        return race(
            this.client.post('api/wifi/connect', url.toString(), {
                headers: new HttpHeaders().append('Content-Type', 'application/x-www-form-urlencoded'),
            }),
            this.presentationService.globalLoader,
        );
    }

    private getCacheKey(fileName: string) {
        return `file:${fileName}`;
    }
}

export type MotionCommand = 'pen-up' | 'pen-down' | 'motors-enable' | 'motors-disable' |
    'print-pause' | 'print-stop' | 'print-continue';

export enum EncryptionType {
    Open = 0,
    Wep = 1,
    WpaPsk = 2,
    Wpa2Psk = 3,
    WpaWpa2Psk = 4,
    Wpa2Enterprise = 5,
}

export interface PrintFile {
    name: string;
}

export interface MotionParams {
    penUpPercent: number;
    penDownPercent: number;
    drawingSpeed: number;
    penMoveDelay: number;
    travelSpeed: number;
    stepsPerRotation: number;
    reversePen: boolean;
    reverseRotation: boolean;
}

export interface Config {
    hScale: number;
    vScale: number;
    vOffset: number;
    simplifySegments: boolean;
    optimizeTravel: boolean;
    reverseSegments: boolean;
    mergeSegments: boolean;
    simplifyThreshold: number;
    minTravelDistance: number;
    layerResolveType: LayerResolveType;
}

export interface Network {
    ssid: string;
    encryptionType: EncryptionType;
    rssi: number;
    channel: number;
    bssid: string;
}

export interface WiFiStatus {
    status: 'idle' | 'no_network' | 'scan_completed' | 'connected' | 'connect_failed' | 'connection_lost' | 'disconnected' | 'unknown';
    ssid: string;
    bssid: string;
}
