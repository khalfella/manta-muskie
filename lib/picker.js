/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

//
// Picker is the component that selects where to send data on PUT requests.
//
// The only method public available from picker is `choose`.  Choose takes
// a desired number of replicas and a size (in bytes), and then selects three
// random "tuples" (the number of items in a tuple is #replicas).  The first
// random tuple is "primary," and then we have 2 backup tuples.  The contract
// here is that upstack code tries all hosts in "primary," and if all are up
// we're good to go; if any fail it falls through to trying all hosts in
// "secondary." While not the most sophisticated and/or error-proof approach,
// this is simple to reason about, and should be "good enough," given what we
// know about our infrastructure (i.e., we expect it to be up).
//
// So in terms of implementation, Picker periodically refreshes a (sorted) set
// of servers per datacenter that is advertised in a moray bucket
// (manta_storage).  To see how data gets in manta_storage, see minnow.git.
//
// So conceptually it looks like this:
//
// {
//   us-east-1: [a, b, c, ...],
//   us-east-2: [d, e, f, ...],
//   us-east-3: [g, h, i, ...],
//   ...
// }
//
// Where the objects `a...N` are the full JSON representation of a single mako
// instance.  In that object, we really only care about two fields:
//
//   -- manta_storage_id (hostname)
//   -- availableMB
//
// We keep those sets sorted by `availableMB`, and everytime choose is run, we
// make a "view" of the set for each data center that tells us all the servers
// that have that amount of storage and larger (binary search).
//
// Once we have that "view," we simply pick random nodes from the set(s).
// Lastly, we RR across DCs so we spread objects around evenly.

var EventEmitter = require('events').EventEmitter;
var util = require('util');
var utils = require('./utils');

var assert = require('assert-plus');
var jsprim = require('jsprim');
var moray = require('moray');
var once = require('once');

var objCommon = require('./obj');
var VError = require('verror');

require('./errors');


///--- Globals

var sprintf = util.format;


///--- Private Functions

/*
 * Used to encode more detailed information about storage selection errors.
 * Providing an error cause allows us to expose more detailed information in
 * logging about why the picker was unable to choose a storage set.
 */
function PickerError(msg) {
    VError.call(this, {
        name: 'PickerError'
    }, msg);
}
util.inherits(PickerError, VError);

// Refreshes the local cache from moray

var fetch = function fetchMoray(opts, cb) {
    assert.object(opts, 'options');
    assert.number(opts.lag, 'options.lag');
    assert.object(opts.moray, 'options.moray');
    assert.number(opts.utilization, 'options.utilization');
    assert.optionalNumber(opts.limit, 'options.limit');
    assert.optionalNumber(opts.marker, 'options.marker');
    assert.optionalArrayOfObject(opts.values, 'options.values');
    assert.func(cb, 'callback');

    cb = once(cb);

    var count = 0;
    var recs = 0;
    var f = sprintf('(&(percentUsed<=%d)(timestamp>=%d)%s)',
                    opts.utilization,
                    Date.now() - opts.lag,
                    opts.marker ? '(_id>=' + opts.marker + ')' : '');
    var marker = opts.marker;
    var _opts = {
        limit: opts.limit || 100,
        sort: {
            attribute: '_id',
            order: 'ASC'
        }
    };
    var req = opts.moray.findObjects('manta_storage', f, _opts);
    var values = opts.values || [];

    req.once('error', cb);

    req.on('record', function onRecord(data) {
        values.push(data.value);
        count = data._count;
        marker = data._id;
        recs++;
    });

    req.once('end', function () {
        /*
         * We only fetch "limit" records, but there may be many more storage
         * nodes than that.  If we saw fewer records than the number that Moray
         * reported matched our query, that means there are more to fetch, so
         * we take another lap.
         */
        if (recs < count) {
            var next = {
                lag: opts.lag,
                limit: opts.limit,
                marker: ++marker,
                moray: opts.moray,
                utilization: opts.utilization,
                values: values
            };
            fetch(next, cb);
        } else {
            cb(null, values);
        }
    });
};


/**
 * A comparison function used to order storage zones based on available space.
 *
 * @param {object} a               - a storage zone object
 * @param {integer} a.availableMB  - free space in MB on the storage zone
 * @param {object} b               - a storage zone object
 * @param {integer} b.availableMB  - free space in MB on the storage zone
 * @throws {TypeError} on bad input.
 */
function storageZoneComparator(a, b) {
    assert.object(a, 'a');
    assert.object(b, 'b');
    assert.number(a.availableMB, 'a.availableMB');
    assert.number(b.availableMB, 'b.availableMB');

    if (a.availableMB < b.availableMB) {
        return (-1);
    } else if (a.availableMB > b.availableMB) {
        return (1);
    }

    return (0);
}


/**
 * A function to sort the storage zones available for normal requests and those
 * available only for operator requests within each datacenter by available
 * storage.
 *
 * @param {object} dcObj   - an object mapping datacenters to their associated
 *                           storage zones
 * @param {object} opDcObj - an object mapping datacenters to their associated
 *                           storage zones
 * @throws {TypeError} on bad input.
 */
function sortAndStoreDcs(dcObj, opDcObj) {
    assert.object(dcObj, 'dcObj');
    assert.object(opDcObj, 'opDcObj');

    var dcCount = 0;
    var operatorDcCount = 0;
    var dcs = Object.keys(dcObj);
    var operatorDcs = Object.keys(opDcObj);

    dcs.forEach(function dcSortAndCount(k) {
        dcObj[k].sort(storageZoneComparator);
        dcCount++;
    });

    operatorDcs.forEach(function opDcSortAndCount(k) {
        opDcObj[k].sort(storageZoneComparator);
        operatorDcCount++;
    });

    if (dcCount > 0) {
        this.datacenters = dcs;
    } else {
        this.log.warn('Picker.sortAndStoreDcs: could not find any minnow ' +
                      'instances');
        this.datacenters = [];
    }

    if (operatorDcCount > 0) {
        this.operatorDatacenters = operatorDcs;
    } else {
        this.log.warn('Picker.sortAndStoreDcs: could not find any minnow ' +
            'instances for operator requests');
        this.operatorDatacenters = [];
    }

    this.dcSharkMap = dcObj;
    this.operatorDcSharkMap = opDcObj;
    this.emit('topology', [this.dcSharkMap, this.operatorDcSharkMap]);

    this.log.trace('Picker.sortAndStoreDcs: done');
}

/**
 * Callback function invoked to process the storage zone query results from
 * moray. The results are sorted based on the datacenter of each storage zone.
 * This function requires that "this" be bound to an instance of Picker.
 */
function handleStorageResults(err, storageZoneResults) {
    clearTimeout(this._storageTimer);
    this._storageTimer =
        setTimeout(pollStorage.bind(this), this.storageInterval);

    if (err) {
        /*
         * Most errors here would be operational errors, including cases
         * where we cannot reach Moray or Moray cannot reach PostgreSQL or
         * the like.  In these cases, we want to log an error (which will
         * likely fire an alarm), but do nothing else.  We'll retry again on
         * our normal interval.  We'll only run into trouble if this doesn't
         * succeed for long enough that minnow records expire, and in that
         * case there's nothing we can really do about it anyway.
         *
         * It's conceivable that we hit a persistent error here like Moray
         * being unable to parse our query.  That's essentially a programmer
         * error in that we'd never expect this to happen in a functioning
         * system.  It's not easy to identify these errors, and there
         * wouldn't be much we could do to handle them anyway, so we treat
         * all errors the same way: log (which fires the alarm) and wait for
         * a retry.
         */
        this.log.error(err, 'Picker.handleStorageResults: unexpected error ' +
            '(will retry)');
        return;
    }

    var dcObj = {};
    var opDcObj = {};

    function sortByDatacenter(maxUtilization, v) {
        if (!opDcObj[v.datacenter]) {
            opDcObj[v.datacenter] = [];
        }

        opDcObj[v.datacenter].push(v);

        /*
         * Moray is queried for the sharks whose utilization is less than or
         * equal to the maximum utilization percentage at which operator writes
         * are still accepted. Find the set of sharks whose utilization is less
         * than or equal to the utilization threshold for all requests.
         */
        if (v.percentUsed <= maxUtilization) {
            if (!dcObj[v.datacenter]) {
                dcObj[v.datacenter] = [];
            }

            dcObj[v.datacenter].push(v);
        }
    }

    storageZoneResults.forEach(sortByDatacenter.bind(this, this.utilization));

    /*
     * We just defer to the next tick so we're not tying
     * up the event loop to sort a lot if the list is large
     */
    setImmediate(sortAndStoreDcs.bind(this, dcObj, opDcObj));
}


/**
 * Function to manage the process of periodically querying Moray for available
 * storage zones under the maximum utilization threshold. This function
 * requires that "this" be bound to an instance of Picker. This period is
 * determined by the value of storageInterval established when the Picker
 * instance is created.
 */
function pollStorage() {
    assert.object(this.client, 'no client connected');
    assert.ok(!this.standalone, 'polling not available in standalone mode');

    var opts = {
        lag: this.lag,
        moray: this.client,
        utilization: this.operatorUtilization
    };

    this.log.trace('Picker.pollStorage: entered');
    clearTimeout(this._storageTimer);
    fetch(opts, handleStorageResults.bind(this));
}


// Just picks a random number, and optionally skips the last one we saw
function random(min, max, skip) {
    var num = (Math.floor(Math.random() * (max - min + 1)) + min);

    if (num === skip)
        num = ((num + 1) % max);

    return (num);
}


/**
 * Modified binary-search. We're looking for the point in the set at which all
 * servers have at least the requested amount of space.  Logically you would
 * then do set.slice(lower_bound(set, 100));
 * But that creates a copy - but really the return value of this to $end is
 * what the picker logic can then look at
 */
function lower_bound(set, size, low, high) {
    assert.arrayOfObject(set, 'set');
    assert.number(size, 'size');
    assert.optionalNumber(low, 'low');

    low = low || 0;
    high = high || set.length;

    while (low < high) {
        var mid = Math.floor(low + (high - low) / 2);
        if (set[mid].availableMB >= size) {
            high = mid;
        } else {
            low = mid + 1;
        }
    }

    if (!set[low] || set[low].availableMB < size)
        low = -1;

    return (low);
}


///--- API

/**
 * Creates an instance of picker, and an underlying moray client.
 *
 * You can pass in all the usual moray-client options, and additionally pass in
 * an `storageInterval` field, which indicates how often to go poll Moray
 * for minnow updates.  The default is 30s.  Additionally, you can pass in a
 * `lag` field, which indicates how much "staleness" to allow in Moray records.
 *  The default for `lag` is 60s.
 */
function Picker(opts) {
    assert.object(opts, 'options');
    assert.number(opts.defaultMaxStreamingSizeMB,
        'options.defaultMaxStreamingSizeMB');
    assert.object(opts.log, 'options.log');
    assert.number(opts.maxUtilizationPct, 'options.maxUtilizationPct');
    assert.optionalObject(opts.moray, 'options.moray');
    assert.optionalBool(opts.multiDC, 'options.multiDC');
    assert.optionalNumber(opts.storageInterval, 'options.storageInterval');
    assert.optionalNumber(opts.lag, 'options.lag');
    assert.optionalBool(opts.standalone, 'options.standalone');

    EventEmitter.call(this);

    /*
     * The dcSharkMap is an object that maps datacenter names to an array of
     * sharks sorted by available storage capacity that are all at or below the
     * storage utilization threshold for normal manta requests.
     */
    this.dcSharkMap = null;
    /*
     * The operatorDcSharkMap is an object that maps datacenter names to an
     * array of sharks sorted by available storage capacity that are all at or
     * below the storage utilization threshold for operator manta requests.
     */
    this.operatorDcSharkMap = null;
    this.datacenters = null;
    this.operatorDatacenters = null;
    this.dcIndex = -1;
    this.storageInterval = parseInt(opts.storageInterval || 30000, 10);
    this.lag = parseInt(opts.lag || (60 * 60 * 1000), 10);
    this.log = opts.log.child({component: 'picker'}, true);
    this.multiDC = opts.multiDC === undefined ? true : opts.multiDC;
    this.url = opts.url;
    this.defMaxSizeMB = opts.defaultMaxStreamingSizeMB;
    this.utilization = opts.maxUtilizationPct;
    this.operatorUtilization = opts.maxOperatorUtilizationPct;

    this.client = null;

    /*
     * `Standalone` mode is used only when an instance of the Picker is needed
     * without having to connect to a Moray first (e.g., for testing).
     */
    if (!opts.standalone) {
        assert.object(opts.moray, 'options.moray');

        var morayOptions = jsprim.deepCopy(opts.moray);
        morayOptions.log = opts.log;

        this.client = moray.createClient(morayOptions);
        this.client.once('connect', pollStorage.bind(this));
        this.once('topology', this.emit.bind(this, 'connect'));
    }
}
util.inherits(Picker, EventEmitter);


Picker.prototype.close = function close() {
    clearTimeout(this._storageTimer);
    if (this.client)
        this.client.close();
};


/**
 * Selects N shark nodes from sharks with more space than the request length.
 *
 * @param {object} options -
 *                   - {number} size => req.getContentLength()
 *                   - {string} requestId => req.getId()
 *                   - {number} replicas => req.header('x-durability-level')
 *                   - {boolean} isOperator => req.caller.account.isOperator
 * @param {funtion} callback => f(err, [sharkClient])
 */
Picker.prototype.choose = function choose(opts, cb) {
    assert.object(opts, 'options');
    assert.optionalObject(opts.log, 'options.log');
    assert.optionalNumber(opts.replicas, 'options.replicas');
    assert.optionalNumber(opts.size, 'options.size');
    assert.optionalBool(opts.isOperator, 'options.isOperator');
    assert.func(cb, 'callback');

    cb = once(cb);

    var dcs = [];
    var log = opts.log || this.log;
    var offsets = [];
    var replicas = opts.replicas || objCommon.DEF_NUM_COPIES;
    var seen = [];
    var self = this;
    var size = Math.ceil((opts.size || 0) / 1048576) || this.defMaxSizeMB;
    var err, err_msg;

    log.debug({
        replicas: replicas,
        size: size,
        defMaxSizeMB: this.defMaxSizeMB
    }, 'Picker.choose: entered');

    /*
     * Determine the index of the first storage node for each DC that has space
     * for an object of the requested size.  If no sharks in a given DC have
     * enough space, we exclude them from the possible set of DCs to choose
     * from.
     */
    function filterDatacenters(sharkMap, dc) {
        var l = lower_bound(sharkMap[dc], size);
        if (l !== -1) {
            dcs.push(dc);
            offsets.push(l);
        }
    }

    var filterFun;

    if (opts.isOperator) {
        filterFun = filterDatacenters.bind(this, this.operatorDcSharkMap);
        this.operatorDatacenters.forEach(filterFun);
    } else {
        filterFun = filterDatacenters.bind(this, this.dcSharkMap);
        this.datacenters.forEach(filterFun);
    }

    var chooseStats = {
        db: opts.isOperator ? self.operatorDcSharkMap : self.dcSharkMap,
        dcsInUse: dcs,
        offsets: offsets
    };

    var enoughDCs = false;
    if (dcs.length === 0) {
        err_msg = sprintf('no DC with sufficient space');
    } else if (replicas > 1 && this.multiDC && dcs.length < 2) {
        err_msg = sprintf('%d copies requested, but only %d DC(s) have ' +
            'sufficient space', replicas, dcs.length);
    } else {
        enoughDCs = true;
    }

    if (!enoughDCs) {
        log.warn('Picker.choose: not enough DCs available');
        assert.string(err_msg, 'no error message set');

        err = new NotEnoughSpaceError(size, new PickerError(err_msg));
        cb(err, null, chooseStats);
        return;
    }

    dcs = utils.shuffle(dcs);

    /*
     * Pick a random shark from the next DC in the round robin ordering.  If it
     * hasn't yet been used for a set, return the shark.
     *
     * If the shark has been chosen for another set, iterate through all sharks
     * in the DC until we find one that hasn't yet been seen.
     *
     * If there are no sharks that haven't yet been used in the DC, return null.
     */
    function host() {
        if (++self.dcIndex >= dcs.length)
            self.dcIndex = 0;

        var ndx = self.dcIndex;
        var dc;
        if (opts.isOperator) {
            dc = self.operatorDcSharkMap[dcs[ndx]];
        } else {
            dc = self.dcSharkMap[dcs[ndx]];
        }

        var s = random(offsets[ndx], dc.length - 1);

        if (seen.indexOf(dc[s].manta_storage_id) === -1) {
            seen.push(dc[s].manta_storage_id);
        } else {
            var start = s;
            do {
                if (++s === dc.length)
                    s = offsets[ndx];

                if (s === start) {
                    log.debug({
                        datacenter: dcs[ndx]
                    }, 'Picker.choose: exhausted DC');
                    return (null);
                }

            } while (seen.indexOf(dc[s].manta_storage_id) !== -1);

            seen.push(dc[s].manta_storage_id);
        }

        return ({
            datacenter: dc[s].datacenter,
            manta_storage_id: dc[s].manta_storage_id
        });
    }

    /*
     * Return a set with `replicas` sharks.
     */
    function set() {
        var s = [];

        for (var j = 0; j < replicas; j++) {
            var _s = host();
            if (_s === null)
                return (null);
            s.push(_s);
        }

        return (s);
    }

    // We always pick three sets, and we pedantically ensure
    // that we've got them splayed x-dc
    var sharks = [];
    for (var i = 0; i < 3; i++) {
        var tuple = set();

        if (!sharks.length && (!tuple || tuple.length < replicas)) {
            err_msg = 'copies requested exceeds number of available ' +
                'storage nodes';
            err = new NotEnoughSpaceError(size, new PickerError(err_msg));
            cb(err, null, chooseStats);
            return;
        } else if (tuple && this.multiDC && replicas > 1) {
            function mapFun(s) {
                return (s.datacenter);
            }

            function reduceFun(last, now) {
                if (last.indexOf(now) === -1) {
                    last.push(now);
                }

                return (last);
            }

            var _dcs = tuple.map(mapFun).reduce(reduceFun, []);

            if (_dcs.length < 2) {
                err_msg = 'insufficient number of DCs selected';
                err = new NotEnoughSpaceError(size, new PickerError(err_msg));
                cb(err, null, chooseStats);
                return;
            }
        }

        if (tuple)
            sharks.push(tuple);
    }

    log.debug({
        replicas: replicas,
        sharks: sharks,
        size: size
    }, 'Picker.choose: done');
    cb(null, sharks, chooseStats);
};


Picker.prototype.toString = function toString() {
    var str = '[object Picker <';
    str += 'datacenters=' + this.datacenters.length + ', ';
    str += 'operatorDatacenters=' + this.operatorDatacenters.length + ', ';
    str += 'storageInterval=' + this.storageInterval + ', ';
    str += 'lag=' + this.lag + ', ';
    if (this.client) {
        // i.e. NOT initialised in `standalone` mode
        str += 'moray=' + this.client.toString();
    }
    str += '>]';

    return (str);
};



///--- Exports

module.exports = {
    createClient: function createClient(options) {
        return (new Picker(options));
    },

    sortAndStoreDcs: sortAndStoreDcs

};
