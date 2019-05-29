/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2019, Joyent, Inc.
 */

var buckets = require('../buckets');
var common = require('../../common');
var errors = require('../../errors');
var obj = require('../../obj');

function headObject(req, res, next) {
    var owner = req.owner.account.uuid;
    var bucket = req.bucket;
    var bucketObject = req.bucketObject;
    var requestId = req.getId();
    var log = req.log;

    log.debug({
        owner: owner,
        bucket: bucket.name,
        bucket_id: bucket.id,
        object: bucketObject.name,
        requestId: requestId
    }, 'headBucketObject: requested');


    var onGetObject = function onGet(err, object_data) {
        var notFoundErr;
        if (err) {
            if (err.name === 'ObjectNotFoundError') {
                notFoundErr = new errors.ObjectNotFoundError(bucketObject.name);
            } else {
                notFoundErr = err;
            }

            log.debug({
                err: notFoundErr,
                owner: owner,
                bucket: bucket.name,
                bucket_id: bucket.id,
                object: bucketObject.name,
                requestId: requestId
            }, 'headObject: error reading object metadata');

            next(notFoundErr);
            return;
        } else {
            log.debug({
                owner: owner,
                bucket: bucket.name,
                bucket_id: bucket.id,
                object: bucketObject.name,
                requestId: requestId
            }, 'headObject: done');
            req.metadata = object_data;
            req.metadata.type = 'bucketobject';
            req.metadata.objectId = object_data.id;
            req.metadata.contentMD5 = object_data.content_md5;
            req.metadata.contentLength = object_data.content_length;
            req.metadata.contentType = object_data.content_type;
            next();
        }
    };

    req.boray.client.getObjectNoVnode(owner, bucket.id, bucketObject.name,
        onGetObject);
}

module.exports = {

    headBucketObjectHandler: function headBucketObjectHandler() {
        var chain = [
            buckets.loadRequest,
            buckets.getBucketIfExists,
            headObject
        ];
        return (chain);
    }

};