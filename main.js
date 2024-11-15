#!/usr/bin/env node
'use strict';

const app = require('express')();
const sharp = require('sharp');
const axios = require('axios');
const pick = require('lodash').pick;
const resemble = require('resemblejs');

const port = process.env.PORT || 8080;
const MAX_CACHE_SIZE = process.env.CACHE || 0;

const MIN_COMPRESS_LENGTH = 1024;
const MIN_TRANSPARENT_COMPRESS_LENGTH = MIN_COMPRESS_LENGTH * 100;

function should_process(req) {
    const { originType, originSize, webp } = req.params;

    if (!originType.startsWith('image')) return false;
    if (originSize === 0) return false;
    if (webp && originSize < MIN_COMPRESS_LENGTH) return false;
    if (!webp &&
        (originType.endsWith('png') || originType.endsWith('gif')) &&
        originSize < MIN_TRANSPARENT_COMPRESS_LENGTH
    ) {
        return false;
    }
    return true;
}

function redirect(req, res) {
    if (res.headersSent) return;

    res.setHeader('content-length', 0);
    res.removeHeader('cache-control');
    res.removeHeader('expires');
    res.removeHeader('date');
    res.removeHeader('etag');
    res.removeHeader('X-Powered-By');
    res.setHeader('location', encodeURI(req.query.url));
    res.status(302).end();
}

app.enable('trust proxy');
app.get('/favicon.ico', (req, res) => res.status(204).end());
app.get('/', (req, res) => {
    axios.get(req.query.url, {
        responseType: 'stream',
        headers: {
            ...pick(req.headers, ['cookie', 'dnt', 'referer']),
            'user-agent': 'Bandwidth-Hero Compressor',
            'x-forwarded-for': req.headers['x-forwarded-for'] || req.ip,
            'via': '1.1 bandwidth-hero'
        }
    }).then(response => {
        if (response.statusCode >= 400) return redirect(req, res);

        // Set headers from the source response
        for (const [key, value] of Object.entries(response.headers)) {
            try {
                res.setHeader(key, value);
            } catch (e) {
                console.log(`[-] Error: ${e.message}`);
            }
        }

        res.setHeader('content-encoding', 'identity');
        req.params.originType = response.headers['content-type'] || '';
        req.params.originSize = parseInt(response.headers['content-length'], 10);

        if (should_process(req)) {
            const format = 'webp';
            let target_image = sharp();

            // Pipe the incoming stream into sharp for processing
            response.data.pipe(target_image);

            // Resize image to a fixed height of 12,480 pixels, keeping the aspect ratio
            target_image = target_image.resize(null, 12480);

            // Apply greyscale if requested
            if (req.query.bw !== '0') {
                target_image = target_image.greyscale();
            }

            // Set compression quality
            if (req.query.l) {
                target_image = target_image.toFormat(format, {
                    quality: parseInt(req.query.l),
                    progressive: true,
                    optimizeScans: true
                });
            }

            // Set output headers and pipe to response
            res.setHeader('content-type', `image/${format}`);
            res.setHeader('x-original-size', req.params.originSize);

            target_image.on('info', info => {
                res.setHeader('content-length', info.size);
                res.setHeader('x-bytes-saved', req.params.originSize - info.size);
            });

            target_image.pipe(res);

        } else {
            // If no processing is needed, pipe the original stream directly
            res.setHeader('x-proxy-bypass', 1);
            res.setHeader('content-length', response.headers['content-length']);
            res.removeHeader('X-Powered-By');
            response.data.pipe(res);
        }
    }).catch(err => {
        console.log(err);
        res.status(200);
        res.removeHeader('X-Powered-By');
        res.write('bandwidth-hero-proxy');
        res.end();
    });
});

app.listen(port, () => {
    console.log(`Running bandwidth hero proxy on ${port}`);
});
