
const { Storage } = require('./storage');
const { getPathInfo, getPathKeys, getChildPath, numberToBytes, bytesToNumber, concatTypedArrays, cloneObject, compareValues, getChildValues } = require('./utils');
const debug = require('./debug');
const { ID } = require('./id');
const { BinaryBPlusTree, BPlusTreeBuilder } = require('./btree');
const { TextEncoder, TextDecoder } = require('text-encoding');
const { PathReference } = require('./path-reference');
const promiseTimeout = require('./promise-timeout');
var colors = require('colors');

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const SECOND = 1000;
const MINUTE = 60000;

const DEBUG_MODE = true;
const CACHE_TIMEOUT = DEBUG_MODE ? 5 * MINUTE : MINUTE;
const LOCK_TIMEOUT = DEBUG_MODE ? 15 * MINUTE : 5 * SECOND;
const BINARY_TREE_FILL_FACTOR_50 = 50;
const BINARY_TREE_FILL_FACTOR_95 = 95;

const VALUE_TYPES = {
    // Native types:
    OBJECT: 1,
    ARRAY: 2,
    NUMBER: 3,
    BOOLEAN: 4,
    STRING: 5,
    // Custom types:
    DATETIME: 6,
    //ID: 7
    BINARY: 8,
    REFERENCE: 9
};

const UNCHANGED = { unchanged: "this data did not change" };
const FLAG_WRITE_LOCK = 0x10;
const FLAG_READ_LOCK = 0x20;
const FLAG_KEY_TREE = 0x40;
const FLAG_VALUE_TYPE = 0xf;

class NodeCacheEntry {

    /**
     * 
     * @param {NodeAddress} address 
     */
    constructor(address) {
        this.address = address;
        this.timeout = undefined;
        this.created = Date.now();
        this.keepAlive();
    }

    keepAlive() {
        clearTimeout(this.timeout);
        this.timeout = setTimeout(NodeCache.remove.bind(NodeCache, this.address), NodeCache.CACHE_DURATION);
    }

    /**
     * 
     * @param {number} pageNr 
     * @param {number} recordNr 
     */
    update(pageNr, recordNr) {
        // this.address.pageNr = pageNr;
        // this.address.recordNr = recordNr;

        // Create new NodeAddress to prevent "contaminating" other references to this address (it might not want to use the new version, eg when cleaning up: releasing old allocation)
        this.address = new NodeAddress(this.address.path, pageNr, recordNr);
        this.updated = Date.now();
        this.keepAlive();
    }

    dispose() {
        clearTimeout(this.timeout);
    }
}

const _nodeAddressCache = { };
class NodeCache {
    static get CACHE_DURATION() { return CACHE_TIMEOUT; }

    /**
     * Updates or adds a NodeAddress to the cache
     * @param {NodeAddress} address 
     */
    static update(address) {
        if (address.path === "") {
            // Don't cache root address, it has to be retrieved from storage.rootAddress
            return;
        }
        let entry = _nodeAddressCache[address.path];
        if (entry) {
            entry.update(address.pageNr, address.recordNr);
        }
        else {
            // New entry
            entry = new NodeCacheEntry(address);
            _nodeAddressCache[address.path] = entry;
        }
    }

    /**
     * Removes a NodeAddress from cache
     * @param {NodeAddress} address 
     */
    static remove(address) {
        let entry = _nodeAddressCache[address.path];
        if (entry) {
            entry.dispose();
            delete _nodeAddressCache[address.path];
        }
    }

    /**
     * 
     * @param {string} path 
     * @param {boolean} markAsDeleted 
     */
    static invalidate(path, markAsDeleted) {
        // Removes all cached addresses for path and its descendants
        let requestedPath = NodePath(path);
        let paths = Object.keys(_nodeAddressCache).filter(cachedPath => {
            return cachedPath === cachedPath || requestedPath.isAncestorOf(cachedPath);
        });
        paths.forEach(invalidatePath => {
            const address = _nodeAddressCache[invalidatePath];
            if (markAsDeleted) {
                this.update(new RemovedNodeAddress(address));
            }
            else {
                this.remove(address);
            }
        });
    }

    /**
     * Finds a cached NodeAddress for a given path. Returns null if the address is not found in cache
     * @param {string} path 
     * @returns {NodeAddress} a cached NodeAddress or null
     */
    static find(path) {
        let entry = _nodeAddressCache[path];
        if (entry && entry.address.path !== "") {
            // Increase lifetime
            entry.keepAlive();
        }
        if (!entry || entry instanceof RemovedNodeAddress) {
            return null;
        }
        return entry.address;
    }

    /**
     * Finds the first cached NodeAddress for the closest ancestor of a given path
     * @param {string} path 
     * @returns {NodeAddress} a cached NodeAddress for an ancestor
     */
    static findAncestor(path) {
        while (true) {
            path = getPathInfo(path).parent;
            if (path === null) { return null; }
            const entry = this.find(path);
            if (entry) { return entry; }
        }
    }
}

class NodeAddress {
    /**
     * @param {string} path 
     * @param {number} pageNr 
     * @param {number} recordNr 
     */
    constructor(path, pageNr, recordNr) {
        this.path = path;
        this.pageNr = pageNr;
        this.recordNr = recordNr;
    }

    /**
     * Compares this address to another address
     * @param {NodeAddress} address 
     */
    equals(address) {
        return this.path === address.path && this.pageNr === address.pageNr && this.recordNr === address.recordNr;
    }
}

class RemovedNodeAddress extends NodeAddress {
    /**
     * Creates a new RemovedNodeAddress that can be used to indicate a node has been removed (use with NodeCache)
     * @param {NodeAddress} address 
     */
    constructor(address) {
        super(address.path, address.pageNr, address.recordNr);
    }
}

class StorageAddressRange {
    /**
     * 
     * @param {number} pageNr 
     * @param {number} recordNr 
     * @param {number} length 
     */
    constructor(pageNr, recordNr, length) {
        this.pageNr = pageNr;
        this.recordNr = recordNr;
        this.length = length;
    }
}

class StorageAddress {
    /**
     * 
     * @param {number} pageNr 
     * @param {number} recordNr 
     */
    constructor(pageNr, recordNr) {
        this.pageNr = pageNr;
        this.recordNr = recordNr;
    }
}

class NodeAllocation {
    /**
     * 
     * @param {StorageAddressRange[]} allocatedRanges 
     */
    constructor(allocatedRanges) {
        this.ranges = allocatedRanges;
    }

    /**
     * @returns {StorageAddress[]}
     */
    get addresses() {
        let addresses = [];
        this.ranges.forEach(range => {
            for (let i = 0; i < range.length; i++) {
                const address = new StorageAddress(range.pageNr, range.recordNr + i);
                addresses.push(address);
            }
        });
        return addresses; 
    }

    get totalAddresses() {
        return this.ranges.map(range => range.length).reduce((total, nr) => total + nr, 0);
    }

    /**
     * @returns {NodeChunkTable}
     */
    toChunkTable() {
        let ranges = this.ranges.map(range => new NodeChunkTableRange(0, range.pageNr, range.recordNr, range.length));

        if (ranges.length === 1 && ranges[0].length === 1) {
            ranges[0].type = 0;  // No CT (Chunk Table)
        }
        else {
            ranges.forEach((range,index) => {
                if (index === 0) {
                    range.type = 1;     // 1st range CT record
                }
                else {
                    range.type = 2;     // CT record with pageNr, recordNr, length
                }
                // TODO: Implement type 3 (contigious pages)
            });
        }
        return new NodeChunkTable(ranges);
    }

    /**
     * 
     * @param {StorageAddress[]} records 
     * @returns {NodeAllocation}
     */
    static fromAdresses(records) {
        let range = new StorageAddressRange(records[0].pageNr, records[0].recordNr, 1);
        let ranges = [range];
        for(let i = 1; i < records.length; i++) {
            if (records[i].pageNr !== range.pageNr || records[i].recordNr !== range.recordNr + range.length) {
                range = new StorageAddressRange(records[i].pageNr, records[i].recordNr, 1);
                ranges.push(range);
            }
            else {
                range.length++;
            }
        }
        return new NodeAllocation(ranges);
    }

    toString() {
        this.normalize();
        return this.ranges.map(range => {
            return `${range.pageNr},${range.recordNr}+${range.length-1}`;
        })
        .join('; ');
    }

    normalize() {
        // Appends ranges
        const total = this.totalAddresses;
        for(let i = 0; i < this.ranges.length; i++) {
            const range = this.ranges[i];
            let adjRange;
            for (let j = i + 1; j < this.ranges.length; j++) {
                const otherRange = this.ranges[j];
                if (otherRange.pageNr !== range.pageNr) { continue; }
                if (otherRange.recordNr === range.recordNr + range.length) {
                    // This range is right before the other range
                    otherRange.length += range.length;
                    otherRange.recordNr = range.recordNr;
                    adjRange = otherRange;
                    break;
                }
                if (range.recordNr === otherRange.recordNr + otherRange.length) {
                    // This range starts right after the other range
                    otherRange.length += range.length; //otherRange.end = range.end;
                    adjRange = otherRange;
                    break;
                }
            }
            if (adjRange) {
                // range has merged with adjacent one
                this.ranges.splice(i, 1);
                i--;
            }
        }
        console.assert(this.totalAddresses === total, `the amount of addresses changed during normalization`);
    }
}

class NodeChunkTable {
    /**
     * 
     * @param {NodeChunkTableRange[]} ranges 
     */
    constructor(ranges) {
        this.ranges = ranges;
    }
}

class NodeChunkTableRange {
    /**
     * 
     * @param {number} type 
     * @param {number} pageNr 
     * @param {number} recordNr 
     * @param {number} length 
     */
    constructor(type, pageNr, recordNr, length) {
        this.type = type;
        this.pageNr = pageNr;
        this.recordNr = recordNr;
        this.length = length;
    }
}

// const _nodeLocks = {};
// /**
//  * 
//  * @param {NodeLock} lock 
//  */
// function _grantOrQueueNodeLock(lock) {
//     let pathLocks = _nodeLocks[path];
//     if (!pathLocks) {
//         pathLocks = _nodeLocks[path] = [];
//     }
//     pathLocks.push(lock);

//     // Find clashing lock
//     const queue = pathLocks
//         .filter(otherLock => otherLock.tid !== lock.tid && otherLock.path === lock.path)
//         .some(otherLock => lock.type === NodeLock.TYPE_WRITE || otherLock.type === NodeLock.TYPE_WRITE);

//     if (queue) {
//         lock.state = NodeLock.STATE_QUEUED;
//         lock.promise = new Promise((resolve, reject) => {
//             lock._resolve = resolve;
//             lock._reject = reject;
//         });
//     }
//     else {
//         lock.state = NodeLock.STATE_GRANTED;
//         lock.granted = Date.now();
//         lock.expires = Date.now() + NodeLock.LOCK_TIMEOUT;
//         lock.expiryTimeout = setTimeout(() => {
//             lock.state = NodeLock.STATE_EXPIRED;

//         }, NodeLock.LOCK_TIMEOUT);
//         lock.promise = Promise.resolve(lock);
//     }
// }

// function _processLockQueue() {
//     // TODO
// }

// class NodeLock {
//     static get LOCK_TIMEOUT() { return 10 * 60 * 1000; } // 10 minutes for testing
//     static get TYPE_READ() { return 'READ'; }
//     static get TYPE_WRITE() { return 'WRITE'; }
//     static get STATE_PENDING() { return 'PENDING'; }
//     static get STATE_QUEUED() { return 'QUEUED'; }
//     static get STATE_GRANTED() { return 'GRANTED'; }
//     static get STATE_EXPIRED() { return 'EXPIRED'; }

//     constructor(path, type, tid) {
//         this.path = path;
//         this.type = type;
//         this.tid = tid;
//         this.state = NodeLock.STATE_PENDING;
//         this.requested = undefined;
//         this.granted = undefined;
//         this.expires = undefined;
//         this.expiryTimeout = undefined;
//     }

//     request() {
//         this.requested = Date.now();
//         return _grantOrQueueNodeLock(this).promise;
//     }

//     release() {
//         // TODO
//     }
// }

function NodePath(path) {
    return {
        get key() {
            return getPathInfo(path).key;
        },
        parentPath() {
            return getPathInfo(path).parent;
        },
        childPath(childKey) {
            return getChildPath(`${path}`, childKey);
        },
        /**
         * Checks if a given path is an ancestor, eg "posts" is an ancestor of "posts/12344/title"
         * @param {string} otherPath 
         * @returns {boolean}
         */
        isAncestorOf(otherPath) {
            if (path === "") { return true; }
            if (path === otherPath) { return false; }
            const ancestorKeys = getPathKeys(path);
            const descendantKeys = getPathKeys(otherPath);
            if (ancestorKeys.length > descendantKeys.length) { return false; }
            return ancestorKeys.every((key, index) => descendantKeys[index] === key);
        },
        /**
         * Checks if a given path is a descendant, eg "posts/1234/title" is a descendant of "posts"
         * @param {string} otherPath 
         * @returns {boolean}
         */
        isDescendantOf(otherPath) {
            if (otherPath === "") { return true; }
            if (path === otherPath) { return false; }
            const ancestorKeys = getPathKeys(otherPath);
            const descendantKeys = getPathKeys(path);
            if (ancestorKeys.length > descendantKeys.length) { return false; }
            return ancestorKeys.every((key, index) => descendantKeys[index] === key);
        },
        /**
         * Checks if a given path is a direct child, eg "posts/1234/title" is a child of "posts/1234"
         * @param {string} otherPath 
         * @returns {boolean}
         */
        isChildOf(otherPath) {
            return getPathInfo(path).parent === otherPath;
        },
        /**
         * Checks if a given path is its parent, eg "posts/1234" is the parent of "posts/1234/title"
         * @param {string} otherPath 
         * @returns {boolean}
         */
        isParentOf(otherPath) {
            return getPathInfo(otherPath).parent === path;
        }
    };
}

/**
 * @type {NodeLock[]}
 */
const _locks = [];

function _allowLock(path, tid, forWriting) {
    // Can this lock be granted now or do we have to wait?
    const conflict = _locks
        .filter(otherLock => otherLock.tid !== tid && otherLock.state === NodeLock.LOCK_STATE.LOCKED)
        .find(otherLock => {
            return (
                // Other lock clashes with requested lock, if:
                // One (or both) of them is for writing
                (forWriting || otherLock.forWriting)

                // and requested lock is on the same or deeper path
                && (
                    path === otherLock.path
                    || NodePath(path).isDescendantOf(otherLock.path)
                )
            );
        });

    const clashes = typeof conflict !== 'undefined';
    return { allow: !clashes, conflict };
}

function _processLockQueue() {
    const pending = _locks
        .filter(lock => 
            lock.state === NodeLock.LOCK_STATE.PENDING
            && (lock.waitingFor === null || lock.waitingFor.state !== NodeLock.LOCK_STATE.LOCKED)
        )
        .sort((a,b) => {
            // // Writes get higher priority so all reads get the most recent data
            // if (a.forWriting === b.forWriting) { 
            //     if (a.requested < b.requested) { return -1; }
            //     else { return 1; }
            // }
            // else if (a.forWriting) { return -1; }
            if (a.priority && !b.priority) { return -1; }
            else if (!a.priority && b.priority) { return 1; }
            return a.requested < b.requested;
        });
    pending.forEach(lock => {
        const check = _allowLock(lock.path, lock.tid, lock.forWriting);
        lock.waitingFor = check.conflict || null;
        if (check.allow) {
            NodeLock.lock(lock)
            .then(lock.resolve)
            .catch(lock.reject);
        }
    });
}

class NodeLock {

    static get LOCK_STATE() {
        return {
            PENDING: 'pending',
            LOCKED: 'locked',
            EXPIRED: 'expired',
            DONE: 'done'
        };
    };

    /**
     * Constructor for a record lock
     * @param {Storage} storage 
     * @param {string} path 
     * @param {string} tid 
     * @param {boolean} forWriting 
     * @param {boolean} priority
     */
    constructor(storage, path, tid, forWriting, priority = false) {
        this.tid = tid;
        this.path = path;
        this.forWriting = forWriting;
        this.priority = priority;
        this.state = NodeLock.LOCK_STATE.PENDING;
        this.storage = storage;
        this.requested = Date.now();
        this.granted = undefined;
        this.expires = undefined;
        this.comment = "";
        this.waitingFor = null;
    }

    release(comment) {
        //return this.storage.unlock(this.path, this.tid, comment);
        return NodeLock.unlock(this, comment || this.comment);
    }

    /**
     * Locks a path for writing. While the lock is in place, it's value cannot be changed by other transactions.
     * @param {string} path path being locked
     * @param {string} tid a unique value to identify your transaction
     * @param {boolean} forWriting if the record will be written to. Multiple read locks can be granted access at the same time if there is no write lock. Once a write lock is granted, no others can read from or write to it.
     * @returns {Promise<NodeLock>} returns a promise with the lock object once it is granted. It's .release method can be used as a shortcut to .unlock(path, tid) to release the lock
     */
    static lock(path, tid, forWriting = true, comment = '', options = { withPriority: false, noTimeout: false }) {
        let lock, proceed;
        if (path instanceof NodeLock) {
            lock = path;
            lock.comment = `(retry: ${lock.comment})`;
            proceed = true;
        }
        else if (_locks.findIndex((l => l.tid === tid && l.state === NodeLock.LOCK_STATE.EXPIRED)) >= 0) {
            return Promise.reject(`lock on tid ${tid} has expired, not allowed to continue`);
        }
        else {

            // // Test the requested lock path
            // let duplicateKeys = getPathKeys(path)
            //     .reduce((r, key) => {
            //         let i = r.findIndex(c => c.key === key);
            //         if (i >= 0) { r[i].count++; }
            //         else { r.push({ key, count: 1 }) }
            //         return r;
            //     }, [])
            //     .filter(c => c.count > 1)
            //     .map(c => c.key);
            // if (duplicateKeys.length > 0) {
            //     console.log(`ALERT: Duplicate keys found in path "/${path}"`.dim.bgRed);
            // }

            lock = new NodeLock(this, path, tid, forWriting, options.withPriority === true);
            lock.comment = comment;
            _locks.push(lock);
            const check = _allowLock(path, tid, forWriting);
            lock.waitingFor = check.conflict || null;
            proceed = check.allow;
        }

        if (proceed) {
            lock.state = NodeLock.LOCK_STATE.LOCKED;
            if (typeof lock.granted === "number") {
                //debug.warn(`lock :: ALLOWING ${lock.forWriting ? "write" : "read" } lock on path "/${lock.path}" by tid ${lock.tid}; ${lock.comment}`);
            }
            else {
                lock.granted = Date.now();
                if (options.noTimeout !== true) {
                    lock.expires = Date.now() + LOCK_TIMEOUT;
                    //debug.warn(`lock :: GRANTED ${lock.forWriting ? "write" : "read" } lock on path "/${lock.path}" by tid ${lock.tid}; ${lock.comment}`);
                    lock.timeout = setTimeout(() => {
                        // In the right situation, this timeout never fires. Target: Bugfree code

                        if (lock.state !== NodeLock.LOCK_STATE.LOCKED) { return; }
                        debug.error(`lock :: ${lock.forWriting ? "write" : "read" } lock on path "/${lock.path}" by tid ${lock.tid} took too long, ${lock.comment}`);
                        lock.state = NodeLock.LOCK_STATE.EXPIRED;
                        // let allTransactionLocks = _locks.filter(l => l.tid === lock.tid).sort((a,b) => a.requested < b.requested ? -1 : 1);
                        // let transactionsDebug = allTransactionLocks.map(l => `${l.state} ${l.forWriting ? "WRITE" : "read"} ${l.comment}`).join("\n");
                        // debug.error(transactionsDebug);

                        _processLockQueue();
                    }, LOCK_TIMEOUT);
                }
            }
            return Promise.resolve(lock);
        }
        else {
            // Keep pending until clashing lock(s) is/are removed
            //debug.warn(`lock :: QUEUED ${lock.forWriting ? "write" : "read" } lock on path "/${lock.path}" by tid ${lock.tid}; ${lock.comment}`);
            console.assert(lock.state === NodeLock.LOCK_STATE.PENDING);
            const p = new Promise((resolve, reject) => {
                lock.resolve = resolve;
                lock.reject = reject;
            });
            return p;
        }
    }

    static unlock(lock, comment, processQueue = true) {// (path, tid, comment) {
        const i = _locks.indexOf(lock); //_locks.findIndex(lock => lock.tid === tid && lock.path === path);
        if (i < 0) {
            const msg = `lock on "/${lock.path}" for tid ${lock.tid} wasn't found; ${comment}`;
            debug.error(`unlock :: ${msg}`);
            return Promise.reject(new Error(msg));
        }
        lock.state = NodeLock.LOCK_STATE.DONE;
        clearTimeout(lock.timeout);
        _locks.splice(i, 1);
        //debug.warn(`unlock :: RELEASED ${lock.forWriting ? "write" : "read" } lock on "/${lock.path}" for tid ${lock.tid}; ${lock.comment}; ${comment}`);
        processQueue && _processLockQueue();
        return Promise.resolve(lock);
    }

    moveToParent() {
        const parentPath = getPathInfo(this.path).parent;
        const check = _allowLock(parentPath, this.tid, this.forWriting);
        if (check.allow) {
            this.waitingFor = null;
            this.path = parentPath;
            this.comment = `moved to parent: ${this.comment}`;
            return Promise.resolve(this);
        }
        else {
            // Unlock without processing the queue
            NodeLock.unlock(this, `moveLockToParent: ${this.comment}`, false);

            // Lock parent node with priority to jump the queue
            return NodeLock.lock(parentPath, this.tid, this.forWriting, `moved to parent (queued): ${this.comment}`, { withPriority: true })
            .then(newLock => {
                return newLock;
            });
        }
    }

    moveTo(otherPath, forWriting) {
        const check = _allowLock(otherPath, this.tid, this.forWriting);
        if (check.allow) {
            this.waitingFor = null;
            this.path = otherPath;
            this.forWriting = forWriting;
            this.comment = `moved to "/${otherPath}": ${this.comment}`;
            return Promise.resolve(this);
        }
        else {
            // Unlock without processing the queue
            NodeLock.unlock(this, `moving to "/${otherPath}": ${this.comment}`, false);

            // Lock other node with priority to jump the queue
            return NodeLock.lock(otherPath, this.tid, forWriting, `moved to "/${otherPath}" (queued): ${this.comment}`, { withPriority: true })
            .then(newLock => {
                return newLock;
            });
        }
    }

}


class NodeInfo {
    /**
     * @param {{path?: string, type?: number, key?: string, index?: number, exists?: boolean, address?: NodeAddress, value?: any }} info
     */
    constructor(info) {
        this.path = info.path;
        this.type = info.type;
        this.index = info.index;
        this.key = info.key;
        this.exists = info.exists;
        this.address = info.address;
        this.value = info.value;
        this.storedAddress = undefined; // If a child address is read from file that has moved, the stored address will be set here

        if (typeof this.path === 'string' && (typeof this.key === 'undefined' && typeof this.index === 'undefined')) {
            let pathInfo = getPathInfo(this.path);
            if (typeof pathInfo.key === 'number') {
                this.index = pathInfo.key;
            }
            else {
                this.key = pathInfo.key;
            }
        }
        if (typeof this.exists === 'undefined') {
            this.exists = true;
        }
    }

    get valueType() {
        return this.type;
    }
}

class RecordInfo {
    /**
     * @param {string} path
     * @param {boolean} hasKeyIndex 
     * @param {number} valueType 
     * @param {NodeAllocation} allocation 
     * @param {number} headerLength 
     * @param {number} lastRecordLength 
     * @param {number} bytesPerRecord
     * @param {Uint8Array} startData
     */
    constructor(path, hasKeyIndex, valueType, allocation, headerLength, lastRecordLength, bytesPerRecord, startData) {
        this.path = path;
        this.hasKeyIndex = hasKeyIndex;
        this.valueType = valueType;
        this.allocation = allocation;
        this.headerLength = headerLength;
        // if (lastRecordLength === 0 && path !== "") {
        //     debug.error(`BUG: Node "/${path}" at ${allocation.addresses[0].pageNr},${allocation.addresses[0].recordNr}+${allocation.addresses.length-1} is empty which should not happen!`.bgRed.dim.bold);
        // }
        this.lastRecordLength = lastRecordLength;
        this.bytesPerRecord = bytesPerRecord;
        this.startData = startData;
    }

    get totalByteLength() {
        if (this.allocation.ranges.length === 1 && this.allocation.ranges[0].length === 1) {
            // Only 1 record used for storage
            return this.lastRecordLength;
        }

        let byteLength = ((this.allocation.totalAddresses-1) * this.bytesPerRecord) + this.lastRecordLength;
        return byteLength;
    }

    get address() {
        const firstRange = this.allocation.ranges[0];
        return new NodeAddress(this.path, firstRange.pageNr, firstRange.recordNr);
    }
}

class NodeNotFoundError extends Error {}
class TruncatedDataError extends Error {}

class NodeReader {
    /**
     * 
     * @param {Storage} storage 
     * @param {NodeAddress} address 
     * @param {NodeLock} lock 
     */
    constructor(storage, address, lock) {

        this.storage = storage;
        this.address = address;
        this.lock = lock;
        this.lockTimestamp = lock.granted;
        
        /** @type {RecordInfo} */
        this.recordInfo = null;

        this._assertLock();
    }

    _assertLock() {
        if (this.lock.state !== NodeLock.LOCK_STATE.LOCKED) {
            throw new Error(`Node "/${this.address.path}" must be (read) locked, current state is ${this.lock.state}`);
        }
        if (this.lock.granted !== this.lockTimestamp) {
            // Lock has been renewed/changed? Will have to be read again if this happens.
            //this.recordInfo = null; 
            // Don't allow this to happen
            throw new Error(`Lock on node "/${this.address.path}" has changed. This is not allowed. Debug this`);
        }
    }

    /**
     * @param {boolean} includeChildNodes
     * @returns {Promise<NodeAllocation>}
     */
    getAllocation(includeChildNodes = false) {
        this._assertLock();

        //debug.error(`getAllocation "/${this.address.path}" (+children: ${includeChildNodes})`);
        if (!includeChildNodes && this.recordInfo !== null) {
            return Promise.resolve(this.recordInfo.allocation);
        }
        else {
            /** @type {NodeAllocation} */
            let allocation = null;

            return this.readHeader()
            .then(() => {
                allocation = this.recordInfo.allocation;
                if (!includeChildNodes) { 
                    return [{ path: this.address.path, allocation }]; 
                }

                const childPromises = [];
                return this.getChildStream()
                .next(child => {
                    let address = child.address;
                    if (address) {
                        // Get child Allocation
                        let childLock;
                        let promise = NodeLock.lock(child.path, this.lock.tid, false, `NodeReader:getAllocation:child "/${child.path}"`)
                        .then(lock => {
                            childLock = lock;
                            const reader = new NodeReader(this.storage, address, lock);
                            return reader.getAllocation(true);
                        })
                        .then(childAllocation => {
                            childLock.release();
                            //allocation.ranges.push(...childAllocation.ranges);
                            return { path: child.path, allocation: childAllocation };
                        });
                        childPromises.push(promise);
                    }
                })
                .then(() => {
                    return Promise.all(childPromises);
                });
            })
            .then(arr => {
                arr.forEach(result => {
                    allocation.ranges.push(...result.allocation.ranges);
                })
                //console.log(childAllocations);
                return allocation;
            });
        }
    }

    /**
     * Reads all data for this node. Only do this when a stream won't do (eg if you need all data because the record contains a string)
     * @returns {Promise<Uint8Array>}
     */
    getAllData() {
        this._assertLock();
        if (this.recordInfo === null) {
            return this.readHeader().then(() => {
                return this.getAllData();
            });
        }

        let allData = new Uint8Array(this.recordInfo.totalByteLength);
        let index = 0;
        return this.getDataStream()
        .next(({ data }) => {
            allData.set(data, index);
            index += data.length;
        })
        .then(() => {
            return allData;
        });
    }

    /**
     * Gets the value stored in this record by parsing the binary data in this and any sub records
     * @param {options} - options: when omitted retrieves all nested data. If include is set to an array of keys it will only return those children. If exclude is set to an array of keys, those values will not be included
     * @returns {Promise<any>} - returns the stored object, array or string
     */
    getValue(options = { include: undefined, exclude: undefined, child_objects: true, no_cache: false }) {
        if (!options) { options = {}; }
        if (typeof options.include !== "undefined" && !(options.include instanceof Array)) {
            throw new TypeError(`options.include must be an array of key names`);
        }
        if (typeof options.exclude !== "undefined" && !(options.exclude instanceof Array)) {
            throw new TypeError(`options.exclude must be an array of key names`);
        }
        if (["undefined","boolean"].indexOf(typeof options.child_objects) < 0) {
            throw new TypeError(`options.child_objects must be a boolean`);
        }

        this._assertLock();

        if (this.recordInfo === null) {
            return this.readHeader().then(() => {
                return this.getValue(options);
            });
        }
        
        debug.log(`Reading node "/${this.address.path}" from address ${this.address.pageNr},${this.address.recordNr}`.magenta);

        return new Promise((resolve, reject) => {
            switch (this.recordInfo.valueType) {
                case VALUE_TYPES.STRING: {
                    this.getAllData()
                    .then(binary => {
                        let str = textDecoder.decode(binary.buffer);
                        resolve(str);
                    });
                    break;
                }
                case VALUE_TYPES.REFERENCE: {
                    this.getAllData()
                    .then(binary => {
                        let path = textDecoder.decode(binary.buffer);
                        resolve(new PathReference(path));
                    });
                    break;
                }
                case VALUE_TYPES.BINARY: {
                    this.getAllData()
                    .then(binary => {
                        resolve(binary.buffer);
                    });
                    break;
                }
                case VALUE_TYPES.ARRAY:
                case VALUE_TYPES.OBJECT: {
                    // We need ALL data, including from child sub records
                    const isArray = this.recordInfo.valueType === VALUE_TYPES.ARRAY;
                    const promises = [];
                    const obj = isArray ? [] : {};
                    const streamOptions = { };
                    if (options.include && options.include.length > 0) {
                        const keyFilter = options.include.filter(key => key.indexOf('/') < 0);
                        if (keyFilter.length > 0) { 
                            streamOptions.keyFilter = keyFilter;
                        }
                    }

                    this.getChildStream(streamOptions)
                    .next((child, index) => {
                        if (options.child_objects === false && [VALUE_TYPES.OBJECT, VALUE_TYPES.ARRAY].indexOf(child.type) >= 0) {
                            // Options specify not to include any child objects
                            return;
                        }
                        if (options.include && options.include.length > 0 && options.include.indexOf(child.key) < 0) { 
                            // This particular child is not in the include list
                            return; 
                        }
                        if (options.exclude && options.exclude.length > 0 && options.exclude.indexOf(child.key) >= 0) {
                            // This particular child is on the exclude list
                            return; 
                        }
                        if (child.address) {
                            let childLock;
                            let childValuePromise = NodeLock.lock(child.address.path, this.lock.tid, false, `NodeReader.getValue:child "/${child.address.path}"`)
                            .then(lock => {
                                childLock = lock;

                                // Are there any relevant nested includes / excludes?
                                let childOptions = {};
                                if (options.include) {
                                    const include = options.include
                                        .filter((path) => path.startsWith("*/") || path.startsWith(`${child.key}/`))
                                        .map(path => path.substr(path.indexOf('/') + 1));
                                    if (include.length > 0) { childOptions.include = include; }
                                }
                                if (options.exclude) {
                                    const exclude = options.exclude
                                        .filter((path) => path.startsWith("*/") || path.startsWith(`${child.key}/`))
                                        .map(path => path.substr(path.indexOf('/') + 1));

                                    if (exclude.length > 0) { childOptions.exclude = exclude; }
                                }
                                if (typeof options.no_cache === 'boolean') {
                                    childOptions.no_cache = options.no_cache;
                                }

                                if (options.no_cache !== true) {
                                    let cachedAddress = NodeCache.find(child.address.path);
                                    if (!cachedAddress) {
                                        NodeCache.update(child.address); // Cache its address
                                    }
                                    // else if (!cachedAddress.equals(child.address)) {
                                    //     debug.warn(`Using cached address to read child node "/${child.address.path}" from  address ${cachedAddress.pageNr},${cachedAddress.recordNr} instead of (${child.address.pageNr},${child.address.recordNr})`.magenta);
                                    //     child.address = cachedAddress;
                                    // }
                                }

                                // debug.log(`Reading child node "/${child.address.path}" from ${child.address.pageNr},${child.address.recordNr}`.magenta);
                                const reader = new NodeReader(this.storage, child.address, childLock);
                                return reader.getValue(childOptions);
                            })
                            .then(val => {
                                childLock.release(`NodeReader.getValue:child done`);
                                obj[isArray ? index : child.key] = val;
                            })
                            .catch(reason => {
                                childLock.release(`NodeReader.getValue:child ERROR`);
                                debug.error(`NodeReader.getValue:child error: `, reason);
                                throw reason;
                            });
                            promises.push(childValuePromise);
                        }
                        else if (typeof child.value !== "undefined") {
                            obj[isArray ? index : child.key] = child.value;
                        }
                        else {
                            if (isArray) {
                                throw `Value for index ${index} has not been set yet, find out why. Path: ${this.address.path}`;
                            }
                            else {
                                throw `Value for key ${child.key} has not been set yet, find out why. Path: ${this.address.path}`;
                            }
                        }
                    })
                    .then(() => {
                        // We're done reading child info
                        return Promise.all(promises); // Wait for any child reads to complete
                    })
                    .then(() => {
                        resolve(obj);
                    })                        
                    .catch(err => {
                        debug.error(err);
                        reject(err);
                    });

                    break;
                }
                default: {
                    throw "Unsupported record value type";
                }
            }
        });
    }

    getDataStream() {
        this._assertLock();

        if (this.recordInfo === null) {
            return this.readHeader()
            .then(() => {
                return this.getDataStream();
            })
        }

        const bytesPerRecord = this.storage.settings.recordSize;
        const maxRecordsPerChunk = 200; // 200: about 25KB of data when using 128 byte records
        let resolve, reject;
        let callback;
        const generator = {
            /**
             * @param {(result: {data: Uint8Array, valueType: number, chunks: { pageNr: number, recordNr: number, length: number }[], chunkIndex: number, totalBytes: number, hasKeyTree: boolean }) => boolean} cb callback function that is called with each chunk read. Reading will stop immediately when false is returned
             * @returns {Promise<{ valueType: number, chunks: { pageNr: number, recordNr: number, length: number }[]}>} returns a promise that resolves when all data is read
             */
            next(cb) { 
                callback = cb; 
                const promise = new Promise((rs, rj) => { resolve = rs; reject = rj; }); 
                read();
                return promise;
            }
        };

        const read = () => {
            const fileIndex = this.storage.getRecordFileIndex(this.address.pageNr, this.address.recordNr);

            return this.readHeader()
            .then(recordInfo => {

                // Divide all allocation ranges into chunks of maxRecordsPerChunk
                const ranges = recordInfo.allocation.ranges;
                const chunks = [];
                let totalBytes = 0;
                ranges.forEach((range, i) => {
                    let chunk = {
                        pageNr: range.pageNr,
                        recordNr: range.recordNr,
                        length: range.length
                    }
                    let chunkLength = (chunk.length * bytesPerRecord);
                    if (i === ranges.length-1) { 
                        chunkLength -= bytesPerRecord;
                        chunkLength += recordInfo.lastRecordLength;
                    }
                    totalBytes += chunkLength;
                    if (i === 0 && chunk.length > 1) {
                        // Split, first chunk contains start data only
                        let remaining = chunk.length - 1;
                        chunk.length = 1;
                        chunks.push(chunk);
                        chunk = {
                            pageNr: chunk.pageNr,
                            recordNr: chunk.recordNr + 1,
                            length: remaining
                        };
                    }
                    while (chunk.length > maxRecordsPerChunk) {
                        // Split so the chunk has maxRecordsPerChunk
                        let remaining = chunk.length - maxRecordsPerChunk;
                        chunk.length = maxRecordsPerChunk;
                        chunks.push(chunk);
                        chunk = {
                            pageNr: chunk.pageNr,
                            recordNr: chunk.recordNr + maxRecordsPerChunk,
                            length: remaining
                        };
                    }
                    chunks.push(chunk);
                });

                const isLastChunk = chunks.length === 1;

                // Run callback with the first chunk (and possibly the only chunk) already read
                const firstChunkData = recordInfo.startData;
                const { valueType, hasKeyIndex, headerLength, lastRecordLength } = recordInfo;
                let proceed = callback({ 
                    data: recordInfo.startData, 
                    valueType, 
                    chunks, 
                    chunkIndex: 0, 
                    totalBytes, 
                    hasKeyTree: hasKeyIndex, 
                    fileIndex, 
                    headerLength
                }) !== false;

                if (!proceed || isLastChunk) {
                    resolve({ valueType, chunks });
                    return;
                }
                const next = (index) => {
                    //debug.log(address.path);
                    const chunk = chunks[index];
                    const fileIndex = this.storage.getRecordFileIndex(chunk.pageNr, chunk.recordNr);
                    let length = chunk.length * bytesPerRecord;
                    if (index === chunks.length-1) {
                        length -= bytesPerRecord;
                        length += lastRecordLength;
                    }
                    const data = new Uint8Array(length);
                    return this.storage.readData(fileIndex, data)
                    .then(bytesRead => {
                        const isLastChunk = index + 1 === chunks.length
                        const proceed = callback({ 
                            data, 
                            valueType, 
                            chunks, 
                            chunkIndex:index, 
                            totalBytes, 
                            hasKeyTree: hasKeyIndex, 
                            fileIndex, 
                            headerLength 
                        }) !== false;

                        if (!proceed || isLastChunk) {
                            resolve({ valueType, chunks });
                            return;
                        }
                        else {
                            return next(index+1);
                        }
                    });
                }
                return next(1);                
            });
        };

        return generator;
    }
 
    /**
     * Starts reading this record, returns a generator that fires .next for each child key until the callback function returns false. The generator (.next) returns a promise that resolves when all child keys have been processed, or was cancelled because false was returned in the generator callback
     * @param {{ keyFilter?: string[] }} options optional options: keyFilter specific keys to get, offers performance and memory improvements when searching specific keys
     * @returns {{next: (cb: (child: NodeInfo, index: number) => boolean) => Promise<void>}  - returns a generator that is called for each child. return false from your .next callback to stop iterating
     */
    getChildStream(options = { keyFilter: undefined }) {
        this._assertLock();

        // if (this.recordInfo === null) {
        //     return this.readHeader()
        //     .then(() => {
        //         return this.getChildStream(options);
        //     })
        // }

        let resolve, reject;
        /** @type {(childInfo: NodeInfo, index: number)} */ let callback;
        let childCount = 0;
        let isArray = this.valueType === VALUE_TYPES.ARRAY;
        const generator = {
            /**
             * 
             * @param {(childInfo: NodeInfo, index: number)} cb 
             */
            next(cb) { 
                callback = cb; 
                const promise = new Promise((rs, rj) => { resolve = rs; reject = rj; });
                start();
                return promise;
            }
        };

        const start = () => {
            if (this.recordInfo === null) {
                return this.readHeader()
                .then(() => {
                    start();
                });
            }

            if (this.recordInfo.hasKeyIndex) {
                return createStreamFromBinaryTree()
                .then(resolve)
                .catch(reject);
            }
            // TODO: Enable again?
            // else if (this.allocation.length === 1 && this.allocation[0].length === 1) {
            //     // We have all data in memory (small record)
            //     return createStreamFromLinearData(this.recordInfo.startData, true).then(resolve).catch(reject);
            // }
            else {
                return this.getDataStream()
                .next(({ data, valueType, chunks, chunkIndex, hasKeyTree, headerLength, fileIndex }) => {
                    let isLastChunk = chunkIndex === chunks.length-1;
                    return createStreamFromLinearData(data, isLastChunk); //, fileIndex
                })
                .then(resolve)
                .catch(reject);
            }
        };

        // Gets children from a indexed binary tree of key/value data
        const createStreamFromBinaryTree = () => {
            
            return new Promise((resolve, reject) => {
                let i = -1;
                const tree = new BinaryBPlusTree(this._treeDataReader.bind(this));
                const processLeaf = (leaf) => {

                    if (!leaf.getNext) {
                        resolve(); // Resolve already, so lock can be removed
                    }

                    const children = leaf.entries
                    .map(entry => {
                        i++;
                        if (options.keyFilter) {
                            if (isArray && options.keyFilter.indexOf(i) < 0) { return null; }
                            else if (!isArray && options.keyFilter.indexOf(entry.key) < 0) { return null; }
                        }
                        // const child = {
                        //     key: entry.key
                        // };
                        const child = new NodeInfo({ path: `${this.address.path}/${entry.key}`, key: entry.key });
                        const res = getValueFromBinary(child, entry.value, 0);
                        if (res.skip) {
                            return null;
                        }
                        // child.type = res.type;
                        // child.address = res.address;
                        // child.value = res.value;
                        return child;
                    })
                    .filter(child => child !== null);

                    i = 0;
                    const stop = !children.every(child => {
                        return callback(child, i++) !== false; // Keep going until callback returns false
                    });
                    if (!stop && leaf.getNext) {
                        leaf.getNext().then(processLeaf);
                    }
                    else if (stop) {
                        resolve(); //done(`readKeyStream:processLeaf, stop=${stop}, last=${!leaf.getNext}`);
                    }
                };

                if (options.keyFilter && !isArray) {
                    let i = 0;
                    const nextKey = () => {
                        const isLastKey = i + 1 === options.keyFilter.length;
                        const key = options.keyFilter[i];
                        tree.find(key)
                        .then(value => {
                            if (isLastKey) {
                                resolve();  // Resolve already, so lock can be removed
                            }

                            let proceed = true;
                            if (value !== null) {
                                const childInfo = new NodeInfo({ path: `${this.address.path}/${key}`, key }); // { key };
                                const res = getValueFromBinary(childInfo, value, 0);
                                if (!res.skip) {
                                    proceed = callback(childInfo, i) !== false;
                                }
                            }
                            if (proceed && !isLastKey) {
                                i++;
                                nextKey();
                            }
                            else if (!proceed) {
                                resolve(); //done(`readKeyStream:nextKey, proceed=${proceed}, last=${isLastKey}`);
                            }
                        });
                    }
                    nextKey();
                }
                else {
                    tree.getFirstLeaf().then(processLeaf);
                }
            });              
        }

        // To get values from binary data:
        /**
         * 
         * @param {NodeInfo} child 
         * @param {number[]} binary 
         * @param {number} index 
         */
        const getValueFromBinary = (child, binary, index) => {
            const startIndex = index;
            const assert = (bytes) => {
                if (index + bytes > binary.length) {
                    throw new TruncatedDataError(`truncated data`); 
                }
            };
            assert(2);
            child.type = binary[index] >> 4;
            //let value, address;
            const tinyValue = binary[index] & 0xf;
            const valueInfo = binary[index + 1];
            const isRemoved = child.type === 0;
            const unusedDataLength = isRemoved ? valueInfo : 0;
            const isTinyValue = (valueInfo & 192) === 64;
            const isInlineValue = (valueInfo & 192) === 128;
            const isRecordValue = (valueInfo & 192) === 192;

            index += 2;
            if (isRemoved) {
                throw new Error("corrupt: removed child data isn't implemented yet");
                // NOTE: will not happen yet because record saving currently rewrites
                // whole records on updating. Adding new/updated data to the end of a 
                // record will offer performance improvements. Rewriting a whole new record
                // can then be scheduled upon x updates
                assert(unusedDataLength);
                index += unusedDataLength;
                child.exists = false;
                return { index, skip: true }; // Don't add this child
            }
            else if (isTinyValue) {
                if (child.type === VALUE_TYPES.BOOLEAN) { child.value = tinyValue === 1; }
                else if (child.type === VALUE_TYPES.NUMBER) { child.value = tinyValue; }
                else if (child.type === VALUE_TYPES.STRING) { child.value = ""; }
                else if (child.type === VALUE_TYPES.ARRAY) { child.value = []; }
                else if (child.type === VALUE_TYPES.OBJECT) { child.value = {}; }
                else if (child.type === VALUE_TYPES.BINARY) { child.value = new ArrayBuffer(0); }
                else if (child.type === VALUE_TYPES.REFERENCE) { child.value = new PathReference(""); }
                else { throw `Tiny value deserialization method missing for value type ${child.type}`};
            }
            else if (isInlineValue) {
                const length = (valueInfo & 63) + 1;
                assert(length);
                const bytes = binary.slice(index, index + length);
                if (child.type === VALUE_TYPES.NUMBER) { child.value = bytesToNumber(bytes); }
                else if (child.type === VALUE_TYPES.STRING) {
                    child.value = textDecoder.decode(Uint8Array.from(bytes)); 
                }
                else if (child.type === VALUE_TYPES.DATETIME) { let time = bytesToNumber(bytes); child.value = new Date(time); }
                //else if (type === VALUE_TYPES.ID) { value = new ID(bytes); }
                else if (child.type === VALUE_TYPES.ARRAY) { throw new Error(`Inline array deserialization not implemented`); }
                else if (child.type === VALUE_TYPES.OBJECT) { throw new Error(`Inline object deserialization not implemented`); }
                else if (child.type === VALUE_TYPES.BINARY) { child.value = new Uint8Array(bytes).buffer; }
                else if (child.type === VALUE_TYPES.REFERENCE) { 
                    const path = textDecoder.decode(Uint8Array.from(bytes));
                    child.value = new PathReference(path); 
                }
                else { 
                    throw `Inline value deserialization method missing for value type ${child.type}`
                };
                index += length;
            }
            else if (isRecordValue) {
                // Record address
                assert(6);
                if (typeof binary.buffer === "undefined") {
                    binary = new Uint8Array(binary);
                }
                const view = new DataView(binary.buffer, binary.byteOffset + index, 6);
                const pageNr = view.getUint32(0);
                const recordNr = view.getUint16(4);
                const childPath = isArray ? `${this.address.path}[${child.index}]` : this.address.path === "" ? child.key : `${this.address.path}/${child.key}`;
                child.address = new NodeAddress(childPath, pageNr, recordNr);

                // // Make sure we have the latest address - if the record was changed and its parent
                // // must still be updated with the new address, we can get it already
                // let cachedAddress = NodeCache.find(child.address.path);
                // if (cachedAddress && !cachedAddress.equals(child.address)) {
                //     child.storedAddress = child.address;
                //     child.address = cachedAddress; //NodeCache.getLatest(child.address);
                // }
                // else {
                //     NodeCache.update(child.address); // Cache anything that comes along!
                // }
                if (child.address && child.address.equals(this.address)) {
                    throw new Error(`Circular reference in record data`);
                }

                index += 6;
            }
            else {
                throw new Error("corrupt");
            }

            //child.file.length = index - startIndex;

            return { index };
        };

        // Gets children from a chunk of data, linear key/value pairs:
        let incompleteData = null;
        const getChildrenFromChunk = (valueType, binary) => {  //, chunkStartIndex) => {
            if (incompleteData !== null) {
                //chunkStartIndex -= incompleteData.length;
                binary = concatTypedArrays(incompleteData, binary);
                incompleteData = null;
            }
            let children = [];
            if (valueType === VALUE_TYPES.OBJECT || valueType === VALUE_TYPES.ARRAY) {
                isArray = valueType === VALUE_TYPES.ARRAY;
                let index = 0;
                const assert = (bytes) => {
                    if (index + bytes > binary.length) { // binary.byteOffset + ... >
                        throw new TruncatedDataError(`truncated data`); 
                    }
                };

                // Index child keys or array indexes
                while(index < binary.length) {
                    childCount++;
                    let startIndex = index;
                    // let child = {
                    //     key: undefined,
                    //     index: undefined,
                    //     type: undefined,
                    //     value: undefined,
                    //     address: undefined,
                    //     // file: {
                    //     //     index: chunkStartIndex + index,
                    //     //     length: 0
                    //     // }
                    // };

                    const child = new NodeInfo({});
    
                    try {
                        if (isArray) {
                            //child.path = `${this.address.path}[${childCount-1}]`;
                            child.path = getChildPath(this.address.path, childCount-1);
                            child.index = childCount-1;
                        }
                        else {
                            assert(2);
                            const keyIndex = (binary[index] & 128) === 0 ? -1 : (binary[index] & 127) << 8 | binary[index+1];
                            if (keyIndex >= 0) {
                                child.key = this.storage.KIT.keys[keyIndex];
                                //child.path =`${this.address.path}/${child.key}`;
                                child.path = getChildPath(this.address.path, child.key);
                                index += 2;
                            }
                            else {
                                const keyLength = (binary[index] & 127) + 1;
                                index++;
                                assert(keyLength);
                                let key = "";
                                for(let i = 0; i < keyLength; i++) {
                                    key += String.fromCharCode(binary[index + i]);
                                }

                                child.key = key;
                                //child.path =`${this.address.path}/${key}`;
                                child.path = getChildPath(this.address.path, key);
                                index += keyLength;
                            }
                        }
        
                        let res = getValueFromBinary(child, binary, index);
                        index = res.index;
                        if (res.skip) {
                            continue;
                        }
                        else if (!isArray && options.keyFilter && options.keyFilter.indexOf(child.key) < 0) {
                            continue;
                        }
                        else if (isArray && options.keyFilter && options.keyFilter.indexOf(child.index) < 0) {
                            continue;
                        }

                        children.push(child);
                    }
                    catch(err) {
                        if (err instanceof TruncatedDataError) { //if (err.message === "corrupt") { throw err; }
                            incompleteData = binary.slice(startIndex);
                            break;
                        }
                        else {
                            throw err;
                        }
                    }
                    // next
                }
            }
            return children;
        }

        let i = 0;
        const createStreamFromLinearData = (chunkData, isLastChunk) => { // , chunkStartIndex
            let children = getChildrenFromChunk(this.recordInfo.valueType, chunkData); //, chunkStartIndex);
            let stop = !children.every(child => {
                const proceed = callback(child, i) !== false; // Keep going until callback returns false
                i++;
                return proceed;
            });
            if (stop || isLastChunk) {
                return false;
            }
        }

        return generator;
    }

    /**
     * Retrieves information about a specific child by key name or index
     * @param {string|number} key key name or index number
     * @returns {Promise<NodeInfo>} returns a Promise that resolves with NodeInfo of the child
     */
    getChildInfo(key) {
        let childInfo = null;
        return this.getChildStream({ keyFilter: [key] })
        .next(info => {
            childInfo = info;
        })
        .then(() => {
            if (childInfo) {
                return childInfo;
            }
            let childPath = getChildPath(this.address.path, key);
            return new NodeInfo({ path: childPath, key, exists: false });
        });
    }

    _treeDataWriter(data, index) {
        const length = data.length;
        const recordSize = this.storage.settings.recordSize;
        const headerLength = this.recordInfo.headerLength;
        const startRecord = {
            nr: Math.floor((headerLength + index) / recordSize),
            offset: (headerLength + index) % recordSize
        };
        const endRecord = {
            nr: Math.floor((headerLength + index + length) / recordSize),
            offset: (headerLength + index + length) % recordSize
        };
        const writeRecords = this.recordInfo.allocation.addresses.slice(startRecord.nr, endRecord.nr + 1);
        const writeRanges = NodeAllocation.fromAdresses(writeRecords).ranges;
        const writes = [];
        const binary = new Uint8Array(data);
        let bOffset = 0;
        for (let i = 0; i < writeRanges.length; i++) {
            const range = writeRanges[i];
            let fIndex = this.storage.getRecordFileIndex(range.pageNr, range.recordNr);
            let bLength = range.length * recordSize;
            if (i === 0) { 
                fIndex += startRecord.offset; 
                bLength -= startRecord.offset; 
            }
            if (bOffset + bLength > length) {
                bLength = length - bOffset;
            }
            let p = this.storage.writeData(fIndex, binary, bOffset, bLength);
            writes.push(p);
            bOffset += bLength;
        }
        return Promise.all(writes);
    }

    // Translates requested data index and length to actual record data location and reads it
    _treeDataReader(index, length) {
        // index to fileIndex:
        // fileIndex + headerLength + (floor(index / recordSize)*recordSize) + (index % recordSize)
        // above is not true for fragmented records

        // start recordNr & offset:
        // recordNr = floor((index + headerLength) / recordSize)
        // offset = (index + headerLength) % recordSize
        // end recordNr & offset:
        // recordNr = floor((index + headerLength + length) / recordSize)
        // offset = (index + headerLength + length) % recordSize
        
        const recordSize = this.storage.settings.recordSize;
        const headerLength = this.recordInfo.headerLength;
        const startRecord = {
            nr: Math.floor((headerLength + index) / recordSize),
            offset: (headerLength + index) % recordSize
        };
        const endRecord = {
            nr: Math.floor((headerLength + index + length) / recordSize),
            offset: (headerLength + index + length) % recordSize
        };
        const readRecords = this.recordInfo.allocation.addresses.slice(startRecord.nr, endRecord.nr + 1);
        const readRanges = NodeAllocation.fromAdresses(readRecords).ranges;
        const reads = [];
        const totalLength = (readRecords.length * recordSize) - startRecord.offset;
        const binary = new Uint8Array(totalLength);
        let bOffset = 0;
        for (let i = 0; i < readRanges.length; i++) {
            const range = readRanges[i];
            let fIndex = this.storage.getRecordFileIndex(range.pageNr, range.recordNr);
            let bLength = range.length * recordSize;
            if (i === 0) { 
                fIndex += startRecord.offset; 
                bLength -= startRecord.offset; 
            }
            let p = this.storage.readData(fIndex, binary, bOffset, bLength);
            reads.push(p);
            bOffset += bLength;
        }
        return Promise.all(reads).then(() => {
            // Convert Uint8Array to byte array (as long as BinaryBPlusTree doesn't work with typed arrays)
            let bytes = [];
            binary.forEach(val => bytes.push(val));
            return bytes;
        });
    }

    readHeader() {
        this._assertLock();

        const bytesPerRecord = this.storage.settings.recordSize;
        const fileIndex = this.storage.getRecordFileIndex(this.address.pageNr, this.address.recordNr);
        let data = new Uint8Array(bytesPerRecord);
        return this.storage.readData(fileIndex, data.buffer)
        .then(bytesRead => {

            const hasKeyIndex = (data[0] & FLAG_KEY_TREE) === FLAG_KEY_TREE;
            const valueType = data[0] & FLAG_VALUE_TYPE; // Last 4-bits of first byte of read data has value type

            let view = new DataView(data.buffer);
            // Read Chunk Table
            // TODO: If the CT is too big for 1 record, it needs to read more records or it will crash... 
            // UPDATE: the max amount of chunks === nr of whole pages needed + 3, so this will (probably) never happen
            // UPDATE: It does! It happened! 17 pages: 2MB of data for 1 node - 17 * 9 = 153 bytes which is > 128!

            let offset = 1;
            let firstRange = new StorageAddressRange(this.address.pageNr, this.address.recordNr, 1);

            /**
             * @type {StorageAddressRange[]}
             */
            const ranges = [firstRange];
            const allocation = new NodeAllocation(ranges);
            let readingRecordIndex = 0;

            // const assert = (length) => {
            //     if (offset + length >= view.byteLength) {
            //         // Need to read more data
            //         readingRecordIndex++;
            //         let address = allocation.addresses[readingRecordIndex];
            //         let fileIndex = this.storage.getRecordFileIndex(address.pageNr, address.recordNr);
            //         let moreData = new Uint8Array(bytesPerRecord);
            //         return this.storage.readData(fileIndex, moreData.buffer)
            //         .then(() => {
            //             data = concatTypedArrays(data, moreData);
            //             view = new DataView(data.buffer);
            //         });
            //     }
            //     else {
            //         return Promise.resolve();
            //     }
            // };

            // const readAllocation = () => {
            //     return assert(1)
            //     .then(() => {
            //         const type = view.getUint8(offset);
            //         if (type === 0) { 
            //             // No more chunks, exit
            //             offset++;
            //         }
            //         else if (type === 1) {
            //             // First chunk is longer than the 1 record already read
            //             return assert(3)
            //             .then(() => {
            //                 firstRange.length = view.getUint16(offset + 1);
            //                 offset += 3;
            //                 return readAllocation();
            //             })
            //         }
            //         else if (type === 2) {
            //             // Next chunk is location somewhere else (not contigious)
            //             return assert(9)
            //             .then(() => {
            //                 const pageNr = view.getUint32(offset + 1);
            //                 const recordNr = view.getUint16(offset + 5);
            //                 const length = view.getUint16(offset + 7);
        
            //                 const range = new StorageAddressRange(pageNr, recordNr, length);
            //                 ranges.push(range);
            //                 offset += 9;    
            //                 return readAllocation();                        
            //             });
            //         }
            //         else if (type === 3) {
            //             // NEW Next chunk is a number of contigious pages (large!)
            //             // NOT IMPLEMENTED YET
            //             return assert(7)
            //             .then(() => {
            //                 const pageNr = view.getUint32(offset + 1);
            //                 const totalPages = view.getUint16(offset + 5);
            //                 const range = new StorageAddressRange(pageNr, 0, totalPages * this.storage.settings.pageSize);
            //                 ranges.push(range);
            //                 offset += 7;
            //                 return readAllocation();                        
            //             });
            //         }
            //     })
            //     .then(() => {
            //         return assert(2)
            //         .then(() => {
            //             const lastRecordDataLength = view.getUint16(offset);
            //             offset += 2;
            //             return lastRecordDataLength;
            //         });
            //     });
            // };
            
            // return readAllocation()
            // .then(lastRecordDataLength => {

            const readAllocationTable = () => {
                return new Promise((resolve, reject) => {                    
                    while(true) {

                        if (offset + 9 + 2 >= data.length) {
                            // Read more data
                            readingRecordIndex++;
                            let address = allocation.addresses[readingRecordIndex];
                            let fileIndex = this.storage.getRecordFileIndex(address.pageNr, address.recordNr);
                            let moreData = new Uint8Array(bytesPerRecord);
                            this.storage.readData(fileIndex, moreData.buffer)
                            .then(() => {
                                data = concatTypedArrays(data, moreData);
                                view = new DataView(data.buffer);
                                readAllocationTable()
                                .then(resolve)
                                .catch(reject);
                            });
                            return;
                        }

                        const type = view.getUint8(offset);
                        if (type === 0) { 
                            // No more chunks, exit
                            offset++;
                            break;
                        }
                        else if (type === 1) {
                            // First chunk is longer than the 1 record already read
                            firstRange.length = view.getUint16(offset + 1);
                            offset += 3;
                        }
                        else if (type === 2) {
                            // Next chunk is location somewhere else (not contigious)
                            const pageNr = view.getUint32(offset + 1);
                            const recordNr = view.getUint16(offset + 5);
                            const length = view.getUint16(offset + 7);

                            const range = new StorageAddressRange(pageNr, recordNr, length);
                            ranges.push(range);
                            offset += 9;    
                        }
                        else if (type === 3) {
                            // NEW Next chunk is a number of contigious pages (large!)
                            // NOT IMPLEMENTED YET
                            const pageNr = view.getUint32(offset + 1);
                            const totalPages = view.getUint16(offset + 5);
                            const range = new StorageAddressRange(pageNr, 0, totalPages * this.storage.settings.pageSize);
                            ranges.push(range);
                            offset += 7;
                        }
                    }
                    resolve();
                });
            }

            return readAllocationTable()
            .then(() => {
                const lastRecordDataLength = view.getUint16(offset);
                offset += 2;

                const headerLength = offset;
                // const allocation = new NodeAllocation(ranges);
                const firstRecordDataLength = ranges.length === 1 && ranges[0].length == 1 
                    ? lastRecordDataLength 
                    : bytesPerRecord - headerLength;

                this.recordInfo = new RecordInfo(
                    this.address.path,
                    hasKeyIndex,
                    valueType,
                    allocation,
                    headerLength,
                    lastRecordDataLength,
                    bytesPerRecord,
                    data.slice(headerLength, headerLength + firstRecordDataLength)
                );

                return this.recordInfo;
            });
        });
    }

    getChildTree() {
        if (this.recordInfo === null) { throw new Error(`record info hasn't been read yet`); }
        if (!this.recordInfo.hasKeyIndex) { throw new Error(`record has no key index tree`); }
        return new BinaryBPlusTree(
            this._treeDataReader.bind(this), 
            1024, 
            this._treeDataWriter.bind(this)
        );
    }
}

class Node {
    static get VALUE_TYPES() { return VALUE_TYPES; }

    /**
     * 
     * @param {Storage} storage 
     * @param {string} path 
     * @returns {Promise<NodeInfo>} promise that resolves with info about the node
     */
    static locate(storage, path, options = { tid: undefined }) {
        if (!options) {
            options = { no_cache: false };
        }

        if (path === "") {
            if (!storage.rootRecord.exists) {
                return Promise.resolve(new NodeInfo({ path, exists: false }));
            }
            return Promise.resolve(new NodeInfo({ path, address: storage.rootRecord.address, exists: true, type: VALUE_TYPES.OBJECT }));
        }

        let address = NodeCache.find(path);
        if (address) {
            return Promise.resolve(new NodeInfo({ path, address }));
        }
        // Cache miss. Find an ancestor node in cache, read it from disk and walk down the tree
        let ancestorAddress = NodeCache.findAncestor(path);
        if (ancestorAddress === null) {
            // Use the root node to start from
            ancestorAddress = storage.rootRecord.address;
        }
        
        let tailPath = path.substr(ancestorAddress.path.length).replace(/^\//, "");
        let keys = getPathKeys(tailPath);

        const tid = options.tid || ID.generate();

        return new Promise((resolve, reject) => {
            const next = (index, parentAddress) => {
                // Because IO reading is async, it is possible that another caller already came
                // accross the node we are trying to resolve. Check the cache again
                let address = NodeCache.find(path);
                if (address) { 
                    // Found by other caller in the mean time, stop IO and return
                    return resolve(new NodeInfo({ path, address })); 
                }

                // Also test if the child address we are about to look up exists already
                let childPath = getChildPath(parentAddress.path, keys[index]);
                address = NodeCache.find(childPath);
                if (address) {
                    return next(index + 1, address);
                }

                // Achieve a read lock on the parent node and read it
                let lock;
                NodeLock.lock(parentAddress.path, tid, false, `Node.locate "/${parentAddress.path}"`)
                .then(l => {
                    lock = l;
                    const reader = new NodeReader(storage, parentAddress, lock);
                    return reader.getChildInfo(keys[index]);
                })
                .then(childInfo => {
                    lock.release(`Node.locate: done with path "/${parentAddress.path}"`);
                    if (childInfo.exists && childInfo.address) {
                        NodeCache.update(childInfo.address);
                    }
                    if (childPath === path) {
                        // This is the node we were looking for
                        resolve(childInfo);
                    }
                    else {
                        // We have to dig deeper
                        if (!childInfo.exists || !childInfo.address) {
                            // Can't go deeper, a parent node doesn't exist, or is not stored in its own record.
                            // Therefore, the child we are looking for cannot exist.
                            resolve(new NodeInfo({ path, exists: false }));
                        }
                        else {
                            // Proceed with next
                            next(index + 1, childInfo.address);
                        }
                    }
                });
            };
            next(0, ancestorAddress);
        });
    }

    /**
     * Updates or overwrite an existing node, or creates a new node. Handles storing of subnodes, 
     * freeing old node and subnodes allocation, and updating/creation of parent nodes. Triggers
     * event notifications and index updates after the update succeeds.
     * @param {Storage} storage 
     * @param {string} path 
     * @param {any} value Any value will do. If the value is small enough to be stored in a parent record, it will take care of it
     * @param {{ merge?: boolean, tid?: string }} options
     */
    static update(storage, path, value, options = { merge: true, tid: undefined, _internal: false }) {

        // debug.log(`Update request for node "/${path}"`);

        const tid = options.tid || ID.generate();
        const pathInfo = getPathInfo(path);
        // const lockPath = pathInfo.parent || path;

        if (value === null) {
            // Deletion of node is requested. Update parent
            return Node.update(storage, pathInfo.parent, { [pathInfo.key]: null }, { merge: true, tid });
        }
        
        if (path !== "" && _valueFitsInline(storage, value)) {
            // Simple value, update parent instead
            return Node.update(storage, pathInfo.parent, { [pathInfo.key]: value }, { merge: true, tid });
        }

        let eventSubscriptions = options._internal 
            ? []
            : storage.subscriptions.getValueSubscribersForPath(path);
        let topEventPath = path;
        let hasValueSubscribers = false;
        if (eventSubscriptions.length > 0) {
            let eventPaths = eventSubscriptions
                .map(sub => { return { path: sub.dataPath, keys: getPathKeys(sub.dataPath) }; })
                .sort((a,b) => {
                    if (a.keys.length < b.keys.length) return -1;
                    else if (a.keys.length > b.keys.length) return 1;
                    return 0;
                });
            let first = eventPaths[0];
            topEventPath = first.path;
            hasValueSubscribers = eventSubscriptions.length > 0;

            // Now get all subscriptions that should execute on the data (includes events on child nodes as well)
            eventSubscriptions = storage.subscriptions.getAllSubscribersForPath(path);
        }
        
        /** @type {NodeLock} */
        let eventDataLock;
        /** @type {NodeLock} */
        let lock;
        let topEventData;

        return NodeLock.lock(topEventPath, tid, true, `Node.update (get topEventPath "/${topEventPath}")`)
        .then(l => {
            lock = l; //eventDataLock = l;
            return Node.locate(storage, topEventPath, { tid });
        })
        .then(eventNodeInfo => {
            if (!eventNodeInfo.exists || options._internal) {
                // Don't load current value
                return null;
            }
            let valueOptions = {};
            if (!hasValueSubscribers && options.merge === true) {
                // Only load current value for properties being updated.
                valueOptions.include = Object.keys(value);
            }
            let reader = new NodeReader(storage, eventNodeInfo.address, lock); //, eventDataLock);
            return reader.getValue(valueOptions);
        })
        .then(value => {
            topEventData = value;
            // Move the lock to the target path and change to write lock
            return lock.moveTo(path, true)
        })
        .then(l => {
            lock = l;
            return Node.locate(storage, path, { tid });
        })
        .then(nodeInfo => {
            if (nodeInfo.exists && nodeInfo.address && options.merge) {
                // Node exists already, is stored in its own record, and it must be updated (merged)
                return _mergeNode(storage, nodeInfo, value, lock); 
            }
            else {
                // Node doesn't exist, isn't stored in its own record, or must be overwritten
                return _createNode(storage, nodeInfo, value, lock);
            }
        })
        .then(result => {
            const { recordMoved, recordInfo, deallocate } = result;

            // Update parent if the record moved
            let parentUpdatePromise = Promise.resolve(false);
            if (recordMoved && pathInfo.parent !== null) {

                // TODO: Orchestrate parent update requests, so they can be processed in 1 go
                // EG: Node.orchestrateUpdate(storage, path, update, currentLock)
                // The above could then check if there are other pending locks for the parent, 
                // then combine all requested updates and process with 1 call.
                parentUpdatePromise = lock.moveToParent()
                .then(parentLock => {
                    lock = parentLock;
                    return Node.update(storage, pathInfo.parent, { [pathInfo.key]: new InternalNodeReference(recordInfo.valueType, recordInfo.address) }, { merge: true, tid: lock.tid, _internal: true });
                })
                .then(() => true);
            }

            return parentUpdatePromise
            .then(parentUpdated => {
                lock && lock.release();

                if (deallocate && deallocate.totalAddresses > 0) {
                    // Release record allocation marked for deallocation
                    debug.log(`Releasing ${deallocate.totalAddresses} addresses (${deallocate.ranges.length} ranges) previously used by node "/${path}" and/or descendants: ${deallocate}`.gray);
                    storage.FST.release(deallocate.ranges);
                }

                // These actions should be performed async after returning from the update:
                // - trigger event notifications
                // - update indexes
                // options._internal !== true && setImmediate(() => {
                if (options._internal !== true) {    
                    // Check if there are any event subscribers
                    const indexes = storage.indexes.getAll(path);
                    if (eventSubscriptions.length > 0 || indexes.length > 0) {

                        // Build data for old/new comparison
                        let newTopEventData = cloneObject(topEventData);
                        if (newTopEventData === null) {
                            // the node didn't exist prior to the update
                            newTopEventData = path === topEventPath ? value : {};
                        }
                        let modifiedData = newTopEventData;
                        if (path !== topEventPath) {
                            let trailPath = path.slice(topEventPath.length).replace(/^\//, '');
                            let trailKeys = getPathKeys(trailPath);
                            while (trailKeys.length > 0) {
                                let childKey = trailKeys.shift();
                                if (!options.merge && trailKeys.length === 0) {
                                    modifiedData[childKey] = value;
                                }
                                else {
                                    modifiedData = modifiedData[childKey];
                                }
                            }
                        }
                        if (options.merge) {
                            Object.keys(value).forEach(key => {
                                let newValue = value[key];
                                if (newValue !== null) {
                                    modifiedData[key] = newValue;
                                }
                                else {
                                    delete modifiedData[key];
                                }
                            });
                        }
                        else if (path === topEventPath) {
                            newTopEventData = modifiedData = value;
                        }

                        // Find out if there are indexes that need to be updated
                        const updatedData = (() => {
                            let topPathKeys = getPathKeys(topEventPath);
                            let trailKeys = getPathKeys(path).slice(topPathKeys.length);
                            let oldValue = topEventData;
                            let newValue = newTopEventData;
                            while (trailKeys.length > 0) {
                                let subKey = trailKeys.shift();
                                // oldValue = oldValue === null ? null : oldValue[subKey];
                                // if (typeof oldValue === 'undefined') { oldValue = null; }
                                // newValue = newValue === null ? null : newValue[subKey];
                                // if (typeof newValue === 'undefined') { newValue = null; }
                                let childValues = getChildValues(subKey, oldValue, newValue);
                                oldValue = childValues.oldValue;
                                newValue = childValues.newValue;
                            }
                            return { oldValue, newValue };
                        })();

                        // Trigger all index updates
                        const runIndexUpdate = (index, path, oldValue, newValue) => {
                            let keyValues = getChildValues(index.key, oldValue, newValue);
                            if (compareValues(keyValues.oldValue, keyValues.newValue) !== 'identical') {
                                index.handleRecordUpdate(path, oldValue, newValue);
                            }
                        }

                        indexes.map(index => {
                            index._keys = getPathKeys(index.path);
                            return index;
                        })
                        .sort((a, b) => {
                            // Deepest paths should fire first, then bubble up the tree
                            if (a._keys.length < b._keys.length) { return 1; }
                            else if (a._keys.length > b._keys.length) { return -1; }
                            return 0;
                        })
                        .forEach(index => {
                            delete index._keys;

                            // Index is either on the updated data path, or on a child path

                            // Example situation:
                            // path = "users/ewout/posts/1" (a post was added)
                            // topEventPath = "users/ewout" (a "child_changed" event was on "users")
                            // index.path is "users/*/posts"
                            // index must be called with data of "users/ewout/posts/1" 

                            let pathKeys = getPathKeys(path);
                            let indexPathKeys = getPathKeys(index.path + '/*');
                            let trailKeys = indexPathKeys.slice(pathKeys.length);
                            let { oldValue, newValue } = updatedData;
                            if (trailKeys.length === 0) {
                                // Index is on updated path
                                return runIndexUpdate(index, path, oldValue, newValue);
                            }
                            const getAllIndexUpdates = (path, oldValue, newValue) => {
                                if (oldValue === null && newValue === null) {
                                    return [];
                                }
                                let pathKeys = getPathKeys(path);
                                let indexPathKeys = getPathKeys(index.path + '/*');
                                let trailKeys = indexPathKeys.slice(pathKeys.length);
                                if (trailKeys.length === 0) {
                                    return [{ path, oldValue, newValue }];
                                }

                                let results = [];
                                while (trailKeys.length > 0) {
                                    let subKey = trailKeys.shift();
                                    if (subKey === '*') {
                                        // Recursion needed
                                        let allKeys = oldValue === null ? [] : Object.keys(oldValue);
                                        newValue !== null && Object.keys(newValue).forEach(key => {
                                            if (allKeys.indexOf(key) < 0) {
                                                allKeys.push(key);
                                            }
                                        });
                                        allKeys.forEach(key => {
                                            let childPath = getChildPath(path, key);
                                            let childValues = getChildValues(childPath, oldValue, newValue);
                                            let childResults = getAllIndexUpdates(trailKeys, childValues.oldValue, childValues.newValue);
                                            results = results.concat(childResults);
                                        });
                                        break; 
                                    }
                                    else {
                                        let values = getChildValues(subKey, oldValue, newValue);
                                        oldValue = values.oldValue;
                                        newValue = values.newValue;
                                        if (oldValue === null && newValue === null) {
                                            break;
                                        }
                                    }
                                }
                                return results;
                            };
                            let results = getAllIndexUpdates(path, oldValue, newValue);
                            results.forEach(result => {
                                runIndexUpdate(index, result.path, result.oldValue, result.newValue);
                            });
                        });

                        const callSubscriberWithValues = (sub, oldValue, newValue, wildcardKey = undefined) => {
                            let trigger = true;
                            let type = sub.type;
                            if (type.startsWith('notify_')) {
                                type = type.slice('notify_'.length);
                            }
                            if (type === "child_changed" && (oldValue === null || newValue === null)) {
                                trigger = false;
                            }
                            else if (type === "value" || type === "child_changed") {
                                let changes = compareValues(oldValue, newValue);
                                trigger = changes !== 'identical';
                            }
                            else if (type === "child_added") {
                                trigger = oldValue === null && newValue !== null;
                            }
                            else if (type === "child_removed") {
                                trigger = oldValue !== null && newValue === null;
                            }
                            let dataPath = sub.dataPath;
                            if (dataPath.endsWith('/*')) {
                                dataPath = dataPath.substr(0, dataPath.length-1);
                                dataPath += wildcardKey;
                            }
                            trigger && storage.subscriptions.trigger(sub.type, sub.path, dataPath, oldValue, newValue);
                        };

                        // Now... trigger all events
                        eventSubscriptions.map(sub => {
                            sub.keys = getPathKeys(sub.dataPath);
                            return sub;
                        })
                        .sort((a, b) => {
                            // Deepest paths should fire first, then bubble up the tree
                            if (a.keys.length < b.keys.length) { return 1; }
                            else if (a.keys.length > b.keys.length) { return -1; }
                            return 0;
                        })
                        .forEach(sub => {
                            let trailPath = sub.dataPath.slice(topEventPath.length).replace(/^\//, '');
                            let trailKeys = getPathKeys(trailPath);
                            let oldValue = topEventData;
                            let newValue = newTopEventData;
                            while (trailKeys.length > 0) {
                                let subKey = trailKeys.shift();
                                if (subKey === '*') {
                                    // Fire on all relevant child keys (compare!)
                                    let allKeys = oldValue === null ? [] : Object.keys(oldValue);
                                    newValue !== null && Object.keys(newValue).forEach(key => {
                                        if (allKeys.indexOf(key) < 0) {
                                            allKeys.push(key);
                                        }
                                    });
                                    allKeys.forEach(key => {
                                        // let val1 = oldValue === null ? null : oldValue[key];
                                        // if (typeof val1 === 'undefined') { val1 = null; }
                                        // let val2 = newValue === null ? null : newValue[key];
                                        // if (typeof val2 === 'undefined') { val2 = null; }
                                        let childValues = getChildValues(key, oldValue, newValue);
                                        callSubscriberWithValues(sub, childValues.oldValue, childValues.newValue, key);
                                    })
                                    return;
                                }
                                else {
                                    // oldValue = oldValue === null ? null : oldValue[subKey];
                                    // if (typeof oldValue === 'undefined') { oldValue = null; }
                                    // newValue = newValue === null ? null : newValue[subKey];
                                    // if (typeof newValue === 'undefined') { newValue = null; }
                                    let childValues = getChildValues(subKey, oldValue, newValue);
                                    oldValue = childValues.oldValue;
                                    newValue = childValues.newValue;
                                }
                            }
                            callSubscriberWithValues(sub, oldValue, newValue);
                            //console.warn(`Should trigger "${sub.type}" event on node "/${sub.dataPath}" with data: `, newValue);
                        });
                    }

                } //});

                return true;
            });
        })
        .catch(err => {
            debug.error(`Node.update ERROR: `, err);
            eventDataLock && eventDataLock.release(`Node.update: error`);
            lock && lock.release(`Node.update: error`);
            return false;
        });
    }

    static exists(storage, path) {
        const tid = ID.generate();
        return Node.locate(storage, path, { tid })
        .then(nodeInfo => {
            return nodeInfo.exists;
        });
    }

    static getValue(storage, path, options = { tid: undefined, include: undefined, exclude: undefined, child_objects: true }) {
        const tid = options.tid || ID.generate();
        var lock;
        return NodeLock.lock(path, tid, false, `Node.getValue "/${path}"`)
        .then(l => {
            lock = l;
            return Node.locate(storage, path, { tid });
        })
        .then(nodeInfo => {
            if (!nodeInfo.exists) {
                return null;
            }
            if (nodeInfo.address) {
                let reader = new NodeReader(storage, nodeInfo.address, lock);
                return reader.getValue({ include: options.include, exclude: options.exclude, child_objects: options.child_objects });
            }
            return nodeInfo.value;
        })
        .then(value => {
            lock.release();
            return value;
        });
    }

    /**
     * Gets info about a child node
     * @param {Storage} storage 
     * @param {string} path 
     * @param {string|number} childKeyOrIndex 
     * @returns {Promise<NodeInfo>}
     */
    static getChildInfo(storage, path, childKeyOrIndex) {
        let childInfo;
        return this.getChildren(storage, path, [childKeyOrIndex])
        .next(info => {
            childInfo = info;
        })
        .then(() => {
            return childInfo;
        })
        .catch(err => {
            throw err;
        });
    }

    /**
     * Enumerates all children of a given Node for reflection purposes
     * @param {Storage} storage 
     * @param {string} path 
     * @param {string[]|number[]} keyFilter
     */
    static getChildren(storage, path, keyFilter = undefined) {
        var callback, resolve, reject;
        const generator = {
            /**
             * 
             * @param {(child: NodeInfo) => boolean} valueCallback callback function to run for each child. Return false to stop iterating
             * @oldparam {(child: { key?: string, index?: number, valueType: number, value?: any }) => boolean} valueCallback callback function to run for each child. Return false to stop iterating
             * @returns {Promise<bool>} returns a promise that resolves with a boolean indicating if all children have been enumerated, or was canceled by the valueCallback function
             */
            next(valueCallback) {
                callback = valueCallback;
                start();
                const promise = new Promise((rs, rj) => { resolve = rs; reject = rj; });
                return promise;
            }
        };
        const start = () => {
            const tid = ID.generate();
            let canceled = false;
            var lock;
            return NodeLock.lock(path, tid, false, `Node.getChildren "/${path}"`)
            .then(l => {
                lock = l;
                return Node.locate(storage, path, { tid });
            })
            .then(nodeInfo => {
                if (!nodeInfo.exists) {
                    throw new NodeNotFoundError(`Node "/${path}" does not exist`);
                }
                const isArray = nodeInfo.type === VALUE_TYPES.ARRAY;
                let reader = new NodeReader(storage, nodeInfo.address, lock);
                return reader.getChildStream({ keyFilter })
                .next(childInfo => {
                    // const child = {
                    //     path: NodePath(path).childPath(isArray ? childInfo.index : childInfo.key),
                    //     key: childInfo.key,
                    //     index: childInfo.index,
                    //     valueType: childInfo.type,
                    //     value: childInfo.value,
                    //     storageType: childInfo.address ? 'record' : 'inline'
                    // }
                    // const proceed = callback(child);
                    const proceed = callback(childInfo);
                    if (proceed === false) { canceled = true; }
                    return proceed;
                });
            })
            .then(() => {
                lock.release();
                resolve(canceled);
            })
            .catch(err => {
                lock.release('Node.getChildren error');
                debug.error(`Error getting children: ${err.message}`);
                reject(err);
            });
        };
        return generator;
    }

    /**
     * Removes a Node. Short for Node.update with value null
     * @param {Storage} storage 
     * @param {string} path 
     */
    static remove(storage, path) {
        return Node.update(storage, path, null);
    }

    /**
     * Sets the value of a Node. Short for Node.update with option { merge: false }
     * @param {Storage} storage 
     * @param {string} path 
     * @param {any} value 
     */
    static set(storage, path, value) {
        return Node.update(storage, path, value, { merge: false });
    }

    /**
     * Performs a transaction on a Node
     * @param {Storage} storage 
     * @param {string} path 
     * @param {(currentValue: any) => Promise<any>} callback callback is called with the current value. The returned value (or promise) will be used as the new value. When the callbacks returns undefined, the transaction will be canceled. When callback returns null, the node will be removed.
     */
    static transaction(storage, path, callback) {
        const tid = ID.generate();
        var state = {
            lock: undefined,
            currentValue: null,
            newValue: null
        };
        return NodeLock.lock(path, tid, true, `Node.getValue "/${path}"`)
        .then(lock => {
            state.lock = lock;
            return Node.locate(storage, path, { tid });
        })
        .then(nodeInfo => {
            if (nodeInfo.address) {
                let reader = new NodeReader(storage, nodeInfo.address, state.lock);
                return reader.getValue();
            }
            return nodeInfo.value;
        })
        .then(currentValue => {
            state.currentValue = currentValue;
            return callback(currentValue); // callback is allowed to return a promise
        })
        .then(newValue => {
            if (typeof newValue === 'undefined') {
                return; // Cancel
            }
            state.newValue = newValue;
            return Node.update(storage, path, newValue, { merge: false, tid });
        })
        .then(recordInfo => {
            state.lock.release();
        })
        .catch(err => {
            debug.error(`Error performing transaction on "${path}": `, err);
            state.lock.release(`Error`);
            throw err;
        });
    }

    /**
     * Check if a node's value matches the passed criteria
     * @param {Array<{ key: string, op: string, compare: string }>} criteria criteria to test
     * @returns {Promise<boolean>} returns a promise that resolves with a boolean indicating if it matched the criteria
     */
    static matches(storage, path, criteria, options = { tid: undefined }) {
        if (criteria.length === 0) {
            return Promise.resolve(true); // No criteria, so yes... It matches!
        }
        const criteriaKeys = criteria.reduce((keys, cr) => {
            if (keys.indexOf(cr.key) < 0) {
                keys.push(cr.key);
            }
            return keys;
        }, []);
        const unseenKeys = criteriaKeys.slice();

        const tid = options.tid || ID.generate();
        /** @type {NodeLock} */let lock;
        let isMatch = true;
        let delayedMatchPromises = [];
        return NodeLock.lock(path, tid, true, `Node.getValue "/${path}"`)
        .then(l => {
            lock = l;
            return Node.locate(storage, path, { tid });
        })
        .then(nodeInfo => {
            let reader = new NodeReader(storage, nodeInfo.address, lock);

            return reader.getChildStream({ keyFilter: criteriaKeys })
            .next(child => {
                unseenKeys.splice(unseenKeys.indexOf(child.key), 1);
                const keyCriteria = criteria
                    .filter(cr => cr.key === child.key)
                    .map(cr => {
                        return { op: cr.op, compare: cr.compare };
                    });
                const result = _childMatchesCriteria(storage, child, keyCriteria, lock);
                isMatch = result.isMatch;
                delayedMatchPromises.push(...result.promises);
                return isMatch;
            });
        })
        .then(() => {
            lock.release(); // Ok to release before child reads are done, because they have their own locks
            if (isMatch) {
                return Promise.all(delayedMatchPromises)
                .then(results => {
                    isMatch = results.every(res => res.isMatch)
                });
            }
        })
        .then(() => {
            if (!isMatch) { return false; }
            // Now, also check keys were not found in the node. (a criterium may be "!exists")
            isMatch = unseenKeys.every(key => {
                const child = new NodeInfo({ key, exists: false });
                return _childMatchesCriteria(storage, child, criteria, lock);
            });
            return isMatch;
        })
        .catch(err => {
            debug.error(`Error matching on "${path}": `, err);
            if (lock.state === NodeLock.LOCK_STATE.LOCKED) {
                lock.release(`Error`);
            }
            throw err;
        });
    }
}

/**
 * 
 * @param {Storage} storage
 * @param {NodeInfo} child 
 * @param {Array<{ op: string, compare: string }>} criteria criteria to test
 * @param {NodeLock} lock
 */
function _childMatchesCriteria(storage, child, criteria, lock) {
    const filters = criteria; // refactor

    const promises = [];
    const isMatch = criteria.every(f => {
        let proceed = true;
        if (f.op === "!exists" || (f.op === "==" && (f.compare === null || f.compare === undefined))) { 
            proceed = !child.exists;
        }
        else if (f.op === "exists" || (f.op === "!=" && (f.compare === null || f.compare === undefined))) {
            proceed = child.exists;
        }
        else if (!child.exists) {
            proceed = false;
        }
        else {
            const isMatch = (val) => {
                if (f.op === "<") { return val < f.compare; }
                if (f.op === "<=") { return val <= f.compare; }
                if (f.op === "==") { return val === f.compare; }
                if (f.op === "!=") { return val !== f.compare; }
                if (f.op === ">") { return val > f.compare; }
                if (f.op === ">=") { return val >= f.compare; }
                if (f.op === "in") { return f.compare.indexOf(val) >= 0; }
                if (f.op === "!in") { return f.compare.indexOf(val) < 0; }
                if (f.op === "matches") {
                    return f.compare.test(val.toString());
                }
                if (f.op === "!matches") {
                    return !f.compare.test(val.toString());
                }
                if (f.op === "between") {
                    return val >= f.compare[0] && val <= f.compare[1];
                }
                if (f.op === "!between") {
                    return val < f.compare[0] || val > f.compare[1];
                }
                if (f.op === "custom") {
                    return f.compare(val);
                }
            };
            
            if (child.address) {
                if (child.valueType === VALUE_TYPES.OBJECT && ["has","!has"].indexOf(f.op) >= 0) {
                    const op = f.op === "has" ? "exists" : "!exists";
                    const p = Node.matches(storage, child.path, [{ key: f.compare, op }], { tid: lock.tid })
                    .then(isMatch => {
                        return { key: child.key, isMatch };
                    });
                    promises.push(p);
                    proceed = true;
                }
                else if (child.valueType === VALUE_TYPES.ARRAY && ["contains","!contains"].indexOf(f.op) >= 0) {
                    // TODO: refactor to use child stream
                    const p = Node.getValue(storage, child.path, { tid: lock.tid })
                    .then(arr => {
                        const i = arr.indexOf(f.compare);
                        return { key: child.key, isMatch: (i >= 0 && f.op === "contains") || (i < 0 && f.op === "!contains") };
                    });
                    promises.push(p);
                    proceed = true;
                }
                else if (child.valueType === VALUE_TYPES.STRING) {
                    const p = Node.getValue(storage, child.path, { tid: lock.tid })
                    .then(val => {
                        return { key: child.key, isMatch: isMatch(val) };
                    });
                    promises.push(p);
                    proceed = true;
                }
                else {
                    proceed = false;
                }
            }
            else if (child.type === VALUE_TYPES.OBJECT && ["has","!has"].indexOf(f.op) >= 0) {
                const has = f.compare in child.value;
                proceed = (has && f.op === "has") || (!has && f.op === "!has");
            }
            else if (child.type === VALUE_TYPES.ARRAY && ["contains","!contains"].indexOf(f.op) >= 0) {
                const contains = child.value.indexOf(f.compare) >= 0;
                proceed = (contains && f.op === "contains") || (!contains && f.op === "!contains");
            }
            else {
                const ret = isMatch(child.value);
                if (ret instanceof Promise) {
                    promises.push(ret);
                    ret = true;
                }
                proceed = ret;
            }
        }
        return proceed;
    }); // fs.every

    return { isMatch, promises };
};


/**
 * 
 * @param {Storage} storage 
 * @param {any} value 
 */
function _valueFitsInline(storage, value) {
    if (typeof value === "number" || typeof value === "boolean" || value instanceof Date || value instanceof InternalNodeReference) {
        return true;
    }
    else if (typeof value === "string") {
        const encoded = textEncoder.encode(value);
        return encoded.length < storage.settings.maxInlineValueSize;
    }
    else if (value instanceof PathReference) {
        const encoded = textEncoder.encode(value.path);
        return encoded.length < storage.settings.maxInlineValueSize;
    }
    else if (value instanceof ArrayBuffer) {
        return value.length < storage.settings.maxInlineValueSize;
    }
    else if (value instanceof Array) {
        return value.length === 0;
    }
    else if (typeof value === "object") {
        return Object.keys(value).length === 0;
    }
    else {
        throw new TypeError(`What else is there?`);
    }
}

class NodeChange {
    static get CHANGE_TYPE() {
        return {
            UPDATE: 'update',
            DELETE: 'delete',
            INSERT: 'insert'
        };
    }

    /**
     * 
     * @param {string|number} keyOrIndex 
     * @param {string} changeType 
     * @param {any} oldValue 
     * @param {any} newValue 
     */
    constructor(keyOrIndex, changeType, oldValue, newValue) {
        this.keyOrIndex = keyOrIndex;
        this.changeType = changeType;
        this.oldValue = oldValue;
        this.newValue = newValue;
    }
}

class NodeChangeTracker {
    /**
     * 
     * @param {string} path 
     */
    constructor(path) {
        this.path = path;
        /** @type {NodeChange[]} */ 
        this._changes = [];
        /** @type {object|Array} */ 
        this._oldValue = undefined;
        this._newValue = undefined;
    }

    addDelete(keyOrIndex, oldValue) {
        this._changes.push(new NodeChange(keyOrIndex, NodeChange.CHANGE_TYPE.DELETE, oldValue, null));
    }
    addUpdate(keyOrIndex, oldValue, newValue) {
        this._changes.push(new NodeChange(keyOrIndex, NodeChange.CHANGE_TYPE.UPDATE, oldValue, newValue));
    }
    addInsert(keyOrIndex, newValue) {
        this._changes.push(new NodeChange(keyOrIndex, NodeChange.CHANGE_TYPE.INSERT, null, newValue));
    }
    add(keyOrIndex, currentValue, newValue) {
        if (currentValue === null) {
            if (newValue === null) { 
                throw new Error(`Wrong logic for node change on "${this.nodeInfo.address.path}/${keyOrIndex}" - both old and new values are null. Ignoring, but check code why this happens`);
            }
            this.addInsert(keyOrIndex, newValue);
        }
        else if (newValue === null) {
            this.addDelete(keyOrIndex, currentValue);
        }
        else {
            this.addUpdate(keyOrIndex, currentValue, newValue);
        }            
    }

    get updates() {
        return this._changes.filter(change => change.changeType === NodeChange.CHANGE_TYPE.UPDATE);
    }
    get deletes() {
        return this._changes.filter(change => change.changeType === NodeChange.CHANGE_TYPE.DELETE);
    }
    get inserts() {
        return this._changes.filter(change => change.changeType === NodeChange.CHANGE_TYPE.INSERT);
    }
    get all() {
        return this._changes;
    }
    get totalChanges() {
        return this._changes.length;
    }
    get(keyOrIndex) {
        return this._changes.find(change => change.keyOrIndex === keyOrIndex);
    }
    hasChanged(keyOrIndex) {
        return !!this.get(keyOrIndex);
    }

    get newValue() {
        if (typeof this._newValue === 'object') { return this._newValue; }
        if (typeof this._oldValue === 'undefined') { throw new TypeError(`oldValue is not set`); }
        let newValue = {};
        Object.keys(this.oldValue).forEach(key => newValue[key] = oldValue[key]);
        this.deletes.forEach(change => delete newValue[change.key]);
        this.updates.forEach(change => newValue[change.key] = change.newValue);
        this.inserts.forEach(change => newValue[change.key] = change.newValue);
        return newValue;
    }
    set newValue(value) {
        this._newValue = value;
    }

    get oldValue() {
        if (typeof this._oldValue === 'object') { return this._oldValue; }
        if (typeof this._newValue === 'undefined') { throw new TypeError(`newValue is not set`); }
        let oldValue = {};
        Object.keys(this.newValue).forEach(key => oldValue[key] = newValue[key]);
        this.deletes.forEach(change => oldValue[change.key] = change.oldValue);
        this.updates.forEach(change => oldValue[change.key] = change.oldValue);
        this.inserts.forEach(change => delete oldValue[change.key]);
        return oldValue;
    }
    set oldValue(value) {
        this._oldValue = value;
    }

    get typeChanged() {
        return typeof this.oldValue !== typeof this.newValue 
            || (this.oldValue instanceof Array && !(this.newValue instanceof Array))
            || (this.newValue instanceof Array && !(this.oldValue instanceof Array));
    }

    static create(path, oldValue, newValue) {
        const changes = new NodeChangeTracker(path);
        changes.oldValue = oldValue;
        changes.newValue = newValue;

        typeof oldValue === 'object' && Object.keys(oldValue).forEach(key => {
            if (typeof newValue === 'object' && key in newValue && newValue !== null) {
                changes.add(key, oldValue[key], newValue[key]);
            }
            else {
                changes.add(key, oldValue[key], null);
            }
        });
        typeof newValue === 'object' && Object.keys(newValue).forEach(key => {
            if (typeof oldValue !== 'object' || !(key in oldValue) || oldValue[key] === null) {
                changes.add(key, null, newValue[key]);
            }
        });
        return changes;
    }
}

/**
 * 
 * @param {Storage} storage 
 * @param {NodeInfo} nodeInfo 
 * @param {object} newValue 
 * @param {NodeLock} lock
 * @returns {RecordInfo}
 */
function _mergeNode(storage, nodeInfo, updates, lock) {
    if (typeof updates !== "object") {
        throw new TypeError(`updates parameter must be an object`);
    }

    const nodeReader = new NodeReader(storage, nodeInfo.address, lock);
    const affectedKeys = Object.keys(updates);
    const changes = new NodeChangeTracker(nodeInfo.path);

    const newKeys = affectedKeys.slice();
    const discardAllocation = new NodeAllocation([]);
    let isArray = false;
    let isInternalUpdate = false;

    return nodeReader.readHeader()
    .then(recordInfo => {

        isArray = recordInfo.valueType === VALUE_TYPES.ARRAY;
        nodeInfo.type = recordInfo.valueType; // Set in nodeInfo too, because it might be unknown

        const childValuePromises = [];

        return nodeReader.getChildStream({ keyFilter: affectedKeys })
        .next(child => {

            const keyOrIndex = isArray ? child.index : child.key;
            newKeys.splice(newKeys.indexOf(keyOrIndex), 1); // Remove from newKeys array, it exists already
            const newValue = updates[keyOrIndex];
    
            // Get current value
            if (child.address) {
                // Child is stored in own record, and it is updated or deleted so we need to get
                // its current value, AND its allocation so we can release it when updating is done
                // UNLESS the updated value for this record is an InternalNodeReference, because then 
                // the allocated data has moved already
                if (newValue instanceof InternalNodeReference) {
                    // This update originates from a child node update
                    isInternalUpdate = true;
                    const oldAddress = child.address; //child.storedAddress || child.address;
                    const currentValue = new InternalNodeReference(child.type, oldAddress);
                    changes.add(keyOrIndex, currentValue, newValue);
                    return true; // Proceed with next (there probably is no next, right?)
                }

                NodeCache.invalidate(child.address.path);

                let currentChildValue;
                const promise = NodeLock.lock(child.address.path, lock.tid, false, `_mergeNode: read child "/${child.address.path}"`)
                .then(childLock => {
                    const childReader = new NodeReader(storage, child.address, childLock);
                    return Promise.all([
                        childReader.getValue().then(value => {
                            currentChildValue = value;
                        }),
                        childReader.getAllocation(true).then(allocation => {
                            discardAllocation.ranges.push(...allocation.ranges);
                            //NodeCache.invalidate(child.address.path, newValue === null);
                        })
                    ])
                    .then(() => {
                        childLock.release();
                        changes.add(keyOrIndex, currentChildValue, newValue);
                    });
                });
                childValuePromises.push(promise);
            }
            else {
                changes.add(keyOrIndex, child.value, newValue);
            }
        })
        .then(() => {
            return Promise.all(childValuePromises);            
        });
    })
    .then(() => {
        // Check which keys we haven't seen (were not in the current node), these will be added
        newKeys.forEach(key => {
            const newValue = updates[key];
            if (newValue !== null) {
                changes.add(key, null, newValue);
            }
        });

        if (isInternalUpdate) {
            debug.log(`Internal update of node "/${nodeInfo.address.path}" triggered by child node update`.cyan);
        }
        else {
            debug.log(`Node "/${nodeInfo.address.path}" being updated: adding ${changes.inserts.length} keys (${changes.inserts.map(ch => `"${ch.keyOrIndex}"`).join(',')}), updating ${changes.updates.length} keys (${changes.updates.map(ch => `"${ch.keyOrIndex}"`).join(',')}), removing ${changes.deletes.length} keys (${changes.deletes.map(ch => `"${ch.keyOrIndex}"`).join(',')})`.cyan);
        }

    //     if (!isInternalUpdate && storage.subscriptions.hasValueSubscribersForPath(nodeInfo.path)) {
    //         // We need the current value for event subscribers before we update
    //         return nodeReader.getValue().then(currentValue => changes.oldValue = currentValue);
    //     }
    // })
    // .then(() => {

        // What we need to do now is make changes to the actual record data. 
        // The record is either a binary B+Tree (larger records), 
        // or a list of key/value pairs (smaller records).
        let updatePromise;
        if (nodeReader.recordInfo.hasKeyIndex) {

            //throw new Error(`NOT IMPLEMENTED YET: CONVERT VALUES TO BINARY`);

            // Try to have the binary B+Tree updated. If there is not enough free space for this
            // (eg, if a leaf to add to is full), we have to rebuild the whole tree and write new records

            const childPromises = [];
            changes.all.forEach(change => {
                const childPath = getChildPath(nodeInfo.path, change.keyOrIndex)
                if (change.oldValue !== null){
                    let kvp = _serializeValue(storage, childPath, change.keyOrIndex, change.oldValue, null);
                    console.assert(kvp instanceof SerializedKeyValue, `return value must be of type SerializedKeyValue, it cannot be a Promise!`);
                    let bytes = _getValueBytes(kvp);
                    change.oldValue = bytes;
                } 
                if (change.newValue !== null) {
                    let s = _serializeValue(storage, childPath, change.keyOrIndex, change.newValue, lock.tid);
                    let convert = (kvp) => {
                        let bytes = _getValueBytes(kvp);
                        change.newValue = bytes;
                    }
                    if (s instanceof Promise) {
                        s = s.then(convert);
                        childPromises.push(s);
                    }
                    else {
                        convert(s);
                    }
                }
            });

            let tree = nodeReader.getChildTree();
            updatePromise = Promise.all(childPromises)
            .then(() => {
                let operations = [];
                changes.deletes.forEach(change => {
                    let oldValue = change.oldValue;
                    if (oldValue instanceof NodeAddress) {
                        oldValue = new InternalNodeReference(oldValue);
                    }
                    oldValue = _getValueBytes(oldValue);
                    operations.push({ type: 'remove', key: change.keyOrIndex, value: change.oldValue });
                });
                changes.updates.forEach(change => {
                    operations.push({ type: 'update', key: change.keyOrIndex, currentValue: change.oldValue, newValue: change.newValue });
                });
                changes.inserts.forEach(change => {
                    operations.push({ type: 'add', key: change.keyOrIndex, value: change.newValue });
                });

                return tree.transaction(operations) // Let's hope it works
            })
            .then(() => {
                // Successfully updated!
                debug.log(`Updated tree for node "/${nodeInfo.path}"`.green); 
                return nodeReader.recordInfo;
            })
            .catch(err => {
                debug.log(`Could not update tree for "/${nodeInfo.path}": ${err.message}`.yellow);
                // Failed to update the binary data, we need to recreate the whole tree
                
                // Use a fillfactor of 95%, so it keeps 5% space free per leaf
                // Nodes that get big tend to use time-based generated keys that are
                // able to sort alphabetically as time passes. So, most adds will
                // take place in the last leaf, which is always filled from 50% on
                let fillFactor = 
                    changes.all.every(ch => typeof ch.keyOrIndex === 'number' || (typeof ch.keyOrIndex === 'string' && /^[0-9]+$/.test(ch.keyOrIndex)) )
                    ? BINARY_TREE_FILL_FACTOR_50
                    : BINARY_TREE_FILL_FACTOR_95;
                return tree.toTreeBuilder(fillFactor) 
                .then(builder => {

                    // Reprocess the changes
                    changes.deletes.forEach(change => {
                        builder.remove(change.keyOrIndex, change.oldValue);
                    });
                    changes.updates.forEach(change => {
                        builder.remove(change.keyOrIndex, change.oldValue);
                        builder.add(change.keyOrIndex, change.newValue);
                    });
                    changes.inserts.forEach(change => {
                        builder.add(change.keyOrIndex, change.newValue);
                    });

                    return builder.create().toBinary(true);
                })
                .then(bytes => {
                    // write new record(s)
                    return _write(storage, nodeInfo.address.path, nodeReader.recordInfo.valueType, bytes, undefined, true, nodeReader.recordInfo);
                })
            });
        }
        else {
            // This is a small record. In the future, it might be nice to make changes 
            // in the record itself, but let's just rewrite it for now.

            // TODO: Do not deallocate here, pass exising allocation to _writeNode, so it can be reused
            // discardAllocation.ranges.push(...nodeReader.recordInfo.allocation.ranges);
            let mergedValue = isArray ? [] : {};

            updatePromise = nodeReader.getChildStream()
            .next(child => {
                let keyOrIndex = isArray ? child.index : child.key;
                if (child.address) { //(child.storedAddress || child.address) {
                    //mergedValue[keyOrIndex] = new InternalNodeReference(child.type, child.storedAddress || child.address);
                    mergedValue[keyOrIndex] = new InternalNodeReference(child.type, child.address);
                }
                else {
                    mergedValue[keyOrIndex] = child.value;
                }
            })
            .then(() => {
                changes.deletes.forEach(change => {
                    delete mergedValue[change.keyOrIndex];
                });
                changes.updates.forEach(change => {
                    mergedValue[change.keyOrIndex] = change.newValue;
                });
                changes.inserts.forEach(change => {
                    mergedValue[change.keyOrIndex] = change.newValue;
                });

                return _writeNode(storage, nodeInfo.path, mergedValue, lock, nodeReader.recordInfo);
            });
        }

        return updatePromise;
    })
    // .then(recordInfo => {
    //     let recordMoved = !recordInfo.address.equals(nodeInfo.address);
    //     return { recordMoved, recordInfo, deallocate: discardAllocation };
    // });
    .then(recordInfo => {
        let recordMoved = false;
        if (recordInfo !== nodeReader.recordInfo) {
            // release the old record allocation
            discardAllocation.ranges.push(...nodeReader.recordInfo.allocation.ranges);
            recordMoved = true;
        }

        return { recordMoved, recordInfo, deallocate: discardAllocation };
    });
}

/**
 * 
 * @param {Storage} storage 
 * @param {NodeInfo} nodeInfo 
 * @param {object} newValue 
 * @param {NodeLock} lock
 * @returns {RecordInfo}
 */
function _createNode(storage, nodeInfo, newValue, lock) {
    let nodeReader = new NodeReader(storage, nodeInfo.address, lock); //Node.getReader(storage, nodeInfo.address, lock);

    debug.log(`Node "/${nodeInfo.path}" is being ${nodeInfo.exists ? 'overwritten' : 'created'}`.cyan);

    /** @type {NodeAllocation} */
    let currentAllocation = null;

    let getCurrentAllocation = Promise.resolve(null);
    if (nodeInfo.exists && nodeInfo.address) {
        // Current value occupies 1 or more records we can probably reuse. 
        // For now, we'll allocate new records though, then free the old allocation
        getCurrentAllocation = nodeReader.getAllocation(true);
    }

    return getCurrentAllocation.then(allocation => {
        currentAllocation = allocation;
        NodeCache.invalidate(nodeInfo.path);
        return _writeNode(storage, nodeInfo.path, newValue, lock); 
    })
    .then(recordInfo => {
        return { recordMoved: true, recordInfo, deallocate: currentAllocation };
    });
}

/**
 * 
 * @param {Storage} storage 
 * @param {string} path 
 * @param {any} value 
 * @param {string} parentTid 
 * @returns {Promise<RecordInfo>}
 */
function _lockAndWriteNode(storage, path, value, parentTid) {
    let lock;
    return NodeLock.lock(path, parentTid, true, `_lockAndWrite "${path}"`)
    .then(l => {
        lock = l;
        return _writeNode(storage, path, value, lock);
    })
    .then(recordInfo => {
        lock.release();
        return recordInfo;
    });
}

/**
 * 
 * @param {Storage} storage 
 * @param {string} path 
 * @param {any} value 
 * @param {NodeLock} lock
 * @returns {Promise<RecordInfo>}
 */
function _writeNode(storage, path, value, lock, currentRecordInfo = undefined) {
    if (lock.path !== path || !lock.forWriting) {
        throw new Error(`Cannot write to node "/${path}" because lock is on the wrong path or not for writing`);
    }

    if (typeof value === "string") {
        const encoded = textEncoder.encode(value);
        return _write(storage, path, VALUE_TYPES.STRING, encoded, value, false, currentRecordInfo);
    }
    else if (value instanceof PathReference) {
        const encoded = textEncoder.encode(value.path);
        return _write(storage, path, VALUE_TYPES.REFERENCE, encoded, value, false, currentRecordInfo);
    }
    else if (value instanceof ArrayBuffer) {
        return _write(storage, path, VALUE_TYPES.BINARY, new Uint8Array(value), value, false, currentRecordInfo);
    }
    else if (typeof value !== "object") {
        throw new TypeError(`Unsupported type to store in stand-alone record`);
    }

    // Store array or object
    let childPromises = [];
    /** @type {SerializedKeyValue[]} */
    let serialized = [];
    let isArray = value instanceof Array;
    
    if (isArray) {
        // Store array
        value.forEach((val, index) => {
            if (typeof val === "undefined" || val === null || typeof val === "function") {
                throw `Array at index ${index} has invalid value. Cannot store null, undefined or functions`;
            }
            const childPath = `${path}[${index}]`;
            let s = _serializeValue(storage, childPath, index, val, lock.tid);
            const add = (s) => {
                serialized.push(s);
            }
            if (s instanceof Promise) {
                s = s.then(add);
                childPromises.push(s);
            }
            else {
                add(s);
            }
        });
    }
    else {
        // Store object
        Object.keys(value).forEach(key => {
            const childPath = getChildPath(path, key); // `${path}/${key}`;
            let val = value[key];
            if (typeof val === "function" || val === null) {
                return; // Skip functions and null values
            }
            else if (typeof val === "undefined") {
                if (storage.settings.removeVoidProperties === true) {
                    delete value[key]; // Kill the property in the passed object as well, to prevent differences in stored and working values
                    return;
                }
                else {
                    throw `Property "${key}" has invalid value. Cannot store undefined values. Set removeVoidProperties option to true to automatically remove undefined properties`;
                }
            }
            else {
                let s = _serializeValue(storage, childPath, key, val, lock.tid);
                const add = (s) => {
                    serialized.push(s);
                }
                if (s instanceof Promise) {
                    s = s.then(add);
                    childPromises.push(s);
                }
                else {
                    add(s);
                }
            }
        });
    }

    return Promise.all(childPromises).then(() => {
        // Append all serialized data into 1 binary array

        let data, keyTree;
        const minKeysPerNode = 25;
        const minKeysForTreeCreation = 100;
        if (true && serialized.length > minKeysForTreeCreation) {
            // Create a B+tree
            keyTree = true;
            let fillFactor = 
            serialized.every(kvp => typeof kvp.index === 'number' || (typeof kvp.key === 'string' && /^[0-9]+$/.test(kvp.key)) )
                ? BINARY_TREE_FILL_FACTOR_50
                : BINARY_TREE_FILL_FACTOR_95;

            const builder = new BPlusTreeBuilder(true, fillFactor);
            serialized.forEach(kvp => {
                let binaryValue = _getValueBytes(kvp);
                builder.add(kvp.key, binaryValue);
            });
            let bytes = builder.create().toBinary(true);
            
            // const keysPerNode = Math.max(minKeysPerNode, Math.ceil(serialized.length / 10));
            // keyTree = new BPlusTree(keysPerNode, true); // 4 for quick testing, should be 10 or so
            // serialized.forEach(kvp => {
            //     let binaryValue = getBinaryValue(kvp);
            //     keyTree.add(kvp.key, binaryValue);
            // });
            // let bytes = keyTree.toBinary();
            data = new Uint8Array(bytes);
        }
        else {
            data = serialized.reduce((binary, kvp) => {
                // For binary key/value layout, see _write function
                let bytes = [];
                if (!isArray) {
                    if (kvp.key.length > 128) { throw `Key ${kvp.key} is too long to store. Max length=128`; }
                    let keyIndex = storage.KIT.getOrAdd(kvp.key); // Gets an caching index for this key

                    // key_info:
                    if (keyIndex >= 0) {
                        // Cached key name
                        bytes[0] = 128;                       // key_indexed = 1
                        bytes[0] |= (keyIndex >> 8) & 127;    // key_nr (first 7 bits)
                        bytes[1] = keyIndex & 255;            // key_nr (last 8 bits)
                    }
                    else {
                        // Inline key name
                        bytes[0] = kvp.key.length - 1;        // key_length
                        // key_name:
                        for (let i = 0; i < kvp.key.length; i++) {
                            let charCode = kvp.key.charCodeAt(i);
                            if (charCode > 255) { throw `Invalid character in key ${kvp.key} at char ${i+1}`; }
                            bytes.push(charCode);
                        }
                    }
                }
                const binaryValue = _getValueBytes(kvp);
                binaryValue.forEach(val => bytes.push(val));//bytes.push(...binaryValue);
                return concatTypedArrays(binary, new Uint8Array(bytes));
            }, new Uint8Array());
        }

        // Now write the record
        return _write(storage, path, isArray ? VALUE_TYPES.ARRAY : VALUE_TYPES.OBJECT, data, serialized, keyTree, currentRecordInfo);
    });
}

class SerializedKeyValue {
    /**
     * 
     * @param {{ key?: string, index?: number, type: number, bool?: boolean, ref?: number|Array|Object, binary?:Uint8Array, record?: NodeAddress, bytes?: Array<number> }} info 
     */
    constructor(info) {
        this.key = info.key;
        this.index = info.index;
        this.type = info.type;
        this.bool = info.bool;
        this.ref = info.ref;
        this.binary = info.binary;
        this.record = info.record; // RENAME
        this.bytes = info.bytes;
    }
}

/**
 * 
 * @param {SerializedKeyValue} kvp 
 */
function _getValueBytes(kvp) {
    // value_type:
    let bytes = [];
    let index = 0;
    bytes[index] = kvp.type << 4;
    // tiny_value?:
    let tinyValue = -1;
    if (kvp.type === VALUE_TYPES.BOOLEAN) { tinyValue = kvp.bool ? 1 : 0; }
    else if (kvp.type === VALUE_TYPES.NUMBER && kvp.ref >= 0 && kvp.ref <= 15 && Math.floor(kvp.ref) === kvp.ref) { tinyValue = kvp.ref; }
    else if (kvp.type === VALUE_TYPES.STRING && kvp.binary && kvp.binary.length === 0) { tinyValue = 0; }
    else if (kvp.type === VALUE_TYPES.ARRAY && kvp.ref.length === 0) { tinyValue = 0; }
    else if (kvp.type === VALUE_TYPES.OBJECT && Object.keys(kvp.ref).length === 0) { tinyValue = 0; }
    if (tinyValue >= 0) {
        // Tiny value
        bytes[index] |= tinyValue;
        bytes.push(64); // 01000000 --> tiny value
        // The end
    }
    else if (kvp.record) {
        // External record
        //recordsToWrite.push(kvp.record);
        index = bytes.length;
        bytes[index] = 192; // 11000000 --> record value
        let address = kvp.record;
        
        // Set the 6 byte record address (page_nr,record_nr)
        let bin = new Uint8Array(6);
        let view = new DataView(bin.buffer);
        view.setUint32(0, address.pageNr);
        view.setUint16(4, address.recordNr);
        bin.forEach(val => bytes.push(val)); //bytes.push(...bin);
        
        // End
    }
    else {
        // Inline value
        let data = kvp.bytes || kvp.binary;
        index = bytes.length;
        bytes[index] = 128; // 10000000 --> inline value
        bytes[index] |= data.length - 1; // inline_length
        data.forEach(val => bytes.push(val)); //bytes.push(...data);
        
        // End
    }
    return bytes;
}

/**
 * 
 * @param {Storage} storage
 * @param {string} path 
 * @param {string|number} keyOrIndex
 * @param {any} val 
 * @param {string} parentTid 
 * @returns {SerializedKeyValue}
 */
function _serializeValue (storage, path, keyOrIndex, val, parentTid) {
    const missingTidMessage = `Need to create a new record, but the parentTid is not given`;
    const create = (details) => {
        if (typeof keyOrIndex === 'number') {
            details.index = keyOrIndex;
        }
        else {
            details.key = keyOrIndex;
        }
        details.ref = val;
        return new SerializedKeyValue(details);
    }
    
    if (val instanceof Date) {
        // Store as 64-bit (8 byte) signed integer. 
        // NOTE: 53 bits seem to the max for the Date constructor in Chrome browser, 
        // although higher dates can be constructed using specific year,month,day etc
        // NOTE: Javascript Numbers seem to have a max "safe" value of (2^53)-1 (Number.MAX_SAFE_INTEGER),
        // this is because the other 12 bits are used for sign (1 bit) and exponent.
        // See https://stackoverflow.com/questions/9939760/how-do-i-convert-an-integer-to-binary-in-javascript
        const ms = val.getTime();
        const bytes = numberToBytes(ms);
        return create({ type: VALUE_TYPES.DATETIME, bytes });
    }
    else if (val instanceof Array) {
        // Create separate record for the array
        if (val.length === 0) {
            return create({ type: VALUE_TYPES.ARRAY, bytes: [] });
        }
        console.assert(parentTid, missingTidMessage);
        return _lockAndWriteNode(storage, path, val, parentTid)
        .then(recordInfo => {
            return create({ type: VALUE_TYPES.ARRAY, record: recordInfo.address });
        });
    }
    else if (val instanceof InternalNodeReference) {
        // Used internally, happens to existing external record data that is not being changed.
        return create({ type: val.type, record: val.address });
    }
    else if (val instanceof ArrayBuffer) {
        if (val.byteLength > storage.settings.maxInlineValueSize) {
            console.assert(parentTid, missingTidMessage);
            return _lockAndWriteNode(storage, path, val, parentTid)
            .then(recordInfo => {
                return create({ type: VALUE_TYPES.BINARY, record: recordInfo.address });
            });                   
        }
        else {
            return { type: VALUE_TYPES.BINARY, bytes: val };
        }
    }
    else if (val instanceof PathReference) {
        const encoded = textEncoder.encode(val.path);
        if (encoded.length > storage.settings.maxInlineValueSize) {
            // Create seperate record for this string value
            console.assert(parentTid, missingTidMessage);
            return _lockAndWriteNode(storage, path, val, parentTid)
            .then(recordInfo => {
                return create({ type: VALUE_TYPES.REFERENCE, record: recordInfo.address });
            });
        }
        else {
            // Small enough to store inline
            return create({ type: VALUE_TYPES.REFERENCE, binary: encoded });
        }
    }
    else if (typeof val === "object") {
        if (Object.keys(val).length === 0) {
            // Empty object (has no properties), can be stored inline
            return create({ type: VALUE_TYPES.OBJECT, bytes: [] });
        }
        // Create seperate record for this object
        console.assert(parentTid, missingTidMessage);
        return _lockAndWriteNode(storage, path, val, parentTid)
        .then(recordInfo => {
            return create({ type: VALUE_TYPES.OBJECT, record: recordInfo.address });
        });
    }
    else if (typeof val === "number") {
        const bytes = numberToBytes(val);
        return create({ type: VALUE_TYPES.NUMBER, bytes });
    }
    else if (typeof val === "boolean") {
        return create({ type: VALUE_TYPES.BOOLEAN, bool: val });
    }
    else {
        // This is a string or something we don't know how to serialize
        if (typeof val !== "string") {
            // Not a string, convert to one
            val = val.toString();
        }
        // Idea for later: Use string interning to store identical string values only once, 
        // using ref count to decide when to remove
        const encoded = textEncoder.encode(val);
        if (encoded.length > storage.settings.maxInlineValueSize) {
            // Create seperate record for this string value
            console.assert(parentTid, missingTidMessage);
            return _lockAndWriteNode(storage, path, val, parentTid)
            .then(recordInfo => {
                return create({ type: VALUE_TYPES.STRING, record: recordInfo.address });
            });
        }
        else {
            // Small enough to store inline
            return create({ type: VALUE_TYPES.STRING, binary: encoded });
        }
    }
};


/**
 * 
 * @param {Storage} storage 
 * @param {string} path 
 * @param {number} type 
 * @param {Uint8Array|Number[]} bytes 
 * @param {any} debugValue 
 * @param {boolean} hasKeyTree 
 * @param {RecordInfo} currentRecordInfo
 * @returns {Promise<RecordInfo>}
 */
function _write(storage, path, type, bytes, debugValue, hasKeyTree, currentRecordInfo = undefined) {
    // Record layout:
    // record           := record_header, record_data
    // record_header    := record_info, value_type, chunk_table, last_record_len
    // record_info      := 4 bits = [0, FLAG_KEY_TREE, FLAG_READ_LOCK, FLAG_WRITE_LOCK]
    // value_type       := 4 bits number
    // chunk_table      := chunk_entry, [chunk_entry, [chunk_entry...]]
    // chunk_entry      := ct_entry_type, [ct_entry_data]
    // ct_entry_type    := 1 byte number, 
    //                      0 = end of table, no entry data
    //                      1 = number of contigious following records (if first range with multiple records, start is current record)
    //                      2 = following range (start address, nr of contigious following record)
    //                      3 = NEW: contigious pages (start page nr, nr of contigious pages)
    //
    // ct_entry_data    := ct_entry_type?
    //                      1: nr_records
    //                      2: start_page_nr, start_record_nr, nr_records
    //                      3: NEW: start_page_nr, nr_pages
    //
    // nr_records       := 2 byte number, (actual nr - 1)
    // nr_pages         := 2 byte number, (actual nr - 1)
    // start_page_nr    := 4 byte number
    // start_record_nr  := 2 byte number
    // last_record_len  := 2 byte number
    // record_data      := value_type?
    //                      OBJECT: FLAG_TREE?
    //                          0: object_property, [object_property, [object_property...]]
    //                          1: object_tree
    //                      ARRAY: array_entry, [array_entry, [array_entry...]]
    //                      STRING: binary_data
    //                      BINARY: binary_data
    //
    // object_property  := key_info, child_info
    // object_tree      := bplus_tree_binary<key_index_or_name, child_info>
    // array_entry      := child_value_type, tiny_value, value_info, [value_data]
    // key_info         := key_indexed, key_index_or_name
    // key_indexed      := 1 bit
    // key_index_or_name:= key_indexed?
    //                      0: key_length, key_name
    //                      1: key_index
    //
    // key_length       := 7 bits (actual length - 1)
    // key_index        := 15 bits
    // key_name         := [key_length] byte string (ASCII)
    // child_info       := child_value_type, tiny_value, value_info, [value_data]
    // child_value_type := 4 bits number
    // tiny_value       := child_value_type?
    //                      BOOLEAN: [0000] or [0001]
    //                      NUMBER: [0000] to [1111] (positive number between 0 and 15)
    //                      (other): (empty string, object, array)
    //
    // value_info       := value_location, inline_length
    // value_location   := 2 bits,
    //                      [00] = DELETED (not implemented yet)
    //                      [01] = TINY
    //                      [10] = INLINE
    //                      [11] = RECORD
    //
    // inline_length    := 6 bits number (actual length - 1)
    // value_data       := value_location?
    //                      INLINE: [inline_length] byte value
    //                      RECORD: value_page_nr, value_record_nr
    //
    // value_page_nr    := 4 byte number
    // value_record_nr  := 2 byte number
    //

    if (bytes instanceof Array) {
        bytes = Uint8Array.from(bytes);
    }
    else if (!(bytes instanceof Uint8Array)) {
        throw new Error(`bytes must be Uint8Array or plain byte Array`);
    }

    const bytesPerRecord = storage.settings.recordSize;
    let headerBytes, totalBytes, requiredRecords, lastChunkSize;

    const calculateStorageNeeds = (nrOfChunks) => {
        // Calculate amount of bytes and records needed
        headerBytes = 4; // Minimum length: 1 byte record_info and value_type, 1 byte CT (ct_entry_type 0), 2 bytes last_chunk_length
        totalBytes = (bytes.length + headerBytes);
        requiredRecords = Math.ceil(totalBytes / bytesPerRecord);
        if (requiredRecords > 1) {
            // More than 1 record, header size increases
            headerBytes += 3; // Add 3 bytes: 1 byte for ct_entry_type 1, 2 bytes for nr_records
            headerBytes += (nrOfChunks - 1) * 9; // Add 9 header bytes for each additional range (1 byte ct_entry_type 2, 4 bytes start_page_nr, 2 bytes start_record_nr, 2 bytes nr_records)
            // Recalc total bytes and required records
            totalBytes = (bytes.length + headerBytes);
            requiredRecords = Math.ceil(totalBytes / bytesPerRecord);
        }
        lastChunkSize = requiredRecords === 1 ? bytes.length : totalBytes % bytesPerRecord;
        if (lastChunkSize === 0 && bytes.length > 0) {
            // Data perfectly fills up the last record!
            // If we don't set it to bytesPerRecord, reading later will fail: 0 bytes will be read from the last record...
            lastChunkSize = bytesPerRecord;
        }
    };

    calculateStorageNeeds(1); // Initialize with calculations for 1 contigious chunk of data

    if (requiredRecords > 1) {
        // In the worst case scenario, we get fragmented record space for each required record.
        // Calculate with this scenario. If we claim a record too many, we'll free it again when done
        let wholePages = Math.floor(requiredRecords / storage.settings.pageSize);
        let maxChunks = Math.max(0, wholePages) + Math.min(3, requiredRecords);
        calculateStorageNeeds(maxChunks);
    }

    // Request storage space for these records
    let useExistingAllocation = currentRecordInfo && currentRecordInfo.allocation.totalAddresses === requiredRecords;
    let allocationPromise = 
        useExistingAllocation
        ? Promise.resolve(currentRecordInfo.allocation.ranges)
        : storage.FST.allocate(requiredRecords);

    return allocationPromise
    .then(ranges => {
        let allocation = new NodeAllocation(ranges);
        !useExistingAllocation && debug.log(`Allocated ${allocation.totalAddresses} addresses for node "/${path}"`.gray);
        
        calculateStorageNeeds(allocation.ranges.length);
        if (requiredRecords < allocation.totalAddresses) {
            const addresses = allocation.addresses;
            const deallocate = addresses.splice(requiredRecords);
            debug.log(`Requested ${deallocate.length} too many addresses to store node "/${path}", releasing them`.gray);
            storage.FST.release(NodeAllocation.fromAdresses(deallocate).ranges);
            allocation = NodeAllocation.fromAdresses(addresses);
            calculateStorageNeeds(allocation.ranges.length);
        }
        
        // Build the binary header data
        let header = new Uint8Array(headerBytes);
        let headerView = new DataView(header.buffer, 0, header.length);
        header.fill(0);     // Set all zeroes
        header[0] = type; // value_type
        if (hasKeyTree) {
            header[0] |= FLAG_KEY_TREE;
        }

        // Add chunk table
        const chunkTable = allocation.toChunkTable();
        let offset = 1;
        chunkTable.ranges.forEach(range => {
            headerView.setUint8(offset, range.type);
            if (range.type === 0) {
                return; // No additional CT data
            }
            else if (range.type === 1) {
                headerView.setUint16(offset + 1, range.length);
                offset += 3;
            }
            else if (range.type === 2) {
                headerView.setUint32(offset + 1, range.pageNr);
                headerView.setUint16(offset + 5, range.recordNr);
                headerView.setUint16(offset + 7, range.length);
                offset += 9;
            }
            else {
                throw "Unsupported range type";
            }
        });
        headerView.setUint8(offset, 0);             // ct_type 0 (end of CT), 1 byte
        offset++;
        headerView.setUint16(offset, lastChunkSize);  // last_chunk_size, 2 bytes
        offset += 2;

        // Create and write all chunks
        bytes = concatTypedArrays(header, bytes);   // NEW: concat header and bytes for simplicity
        const writes = [];
        let copyOffset = 0;
        chunkTable.ranges.forEach((range, r) => {
            const chunk = {
                data: new Uint8Array(range.length * bytesPerRecord),
                get length() { return this.data.length; }
            };

            //chunk.data.fill(0); // not necessary

            // if (r === 0) {
            //     chunk.data.set(header, 0); // Copy header data into first chunk
            //     const view = new Uint8Array(bytes.buffer, 0, Math.min(bytes.length, chunk.length - header.length));
            //     chunk.data.set(view, header.length); // Copy first chunk of data into range
            //     copyOffset += view.length;
            // }
            // else {

            // Copy chunk data from source data
            const view = new Uint8Array(bytes.buffer, copyOffset, Math.min(bytes.length - copyOffset, chunk.length));
            chunk.data.set(view, 0);
            copyOffset += chunk.length;
            
            // }
            const fileIndex = storage.getRecordFileIndex(range.pageNr, range.recordNr);
            if (isNaN(fileIndex)) {
                throw new Error(`fileIndex is NaN!!`);
            }
            const promise = storage.writeData(fileIndex, chunk.data);
            writes.push(promise);
            // const p = promiseTimeout(30000, promise).catch(err => {
            //     // Timeout? 30s to write some data is quite long....
            //     debug.error(`Failed to write ${chunk.data.length} byte chunk for node "/${path}" at file index ${fileIndex}: ${err}`);
            //     throw err;
            // });
            // writes.push(p);
        });

        return Promise.all(writes)
        .then((results) => {
            const bytesWritten = results.reduce((a,b) => a + b, 0);
            const chunks = results.length;
            const address = new NodeAddress(path, allocation.ranges[0].pageNr, allocation.ranges[0].recordNr);

            debug.log(`Node "/${address.path}" saved at address ${address.pageNr},${address.recordNr} - ${allocation.totalAddresses} addresses, ${bytesWritten} bytes written in ${chunks} chunk(s)`.green);
            
            let recordInfo;
            if (useExistingAllocation) {
                // By using the exising info, caller knows it should not release the allocation
                recordInfo = currentRecordInfo;
                recordInfo.allocation = allocation; // Necessary?
                recordInfo.hasKeyIndex = hasKeyTree;
                recordInfo.headerLength = headerBytes;
                recordInfo.lastChunkSize = lastChunkSize;
            }
            else {
                recordInfo = new RecordInfo(address.path, hasKeyTree, type, allocation, headerBytes, lastChunkSize, bytesPerRecord);
                recordInfo.fileIndex = storage.getRecordFileIndex(address.pageNr, address.recordNr);
            }
            recordInfo.timestamp = Date.now();

            NodeCache.update(address);
            if (address.path === "") {
                return storage.rootRecord.update(address) // Wait for this, the address update has to be written to file
                .then(() => recordInfo);
            }
            else {
                return recordInfo;
            }
        })
        .catch(reason => {
            // If any write failed, what do we do?
            debug.error(`Failed to write node "/${path}": ${reason}`);
            throw reason;
        });
    });
}

class InternalNodeReference {
    /**
     * @param {number} type valueType
     * @param {NodeAddress} address 
     */
    constructor(type, address) {
        this.type = type;
        this._address = address;
    }
    get address() {
        return this._address;
    }
    get path() {
        return this._address.path;
    }
    get pageNr() {
        return this._address.pageNr;
    }
    get recordNr() {
        return this._address.recordNr;
    }
}

// class Generator {

//     constructor(start) {
//         this.start = start;
//         this.callback = null;
//         this.resolve = null;
//         this.reject = null;

//         var callback, resolve, reject;
//         const generator = {

//         };        
//     }
//     /**
//      * @param {(value: any) => boolean} valueCallback callback for each value. Return false to stop iterating
//      * @returns {Promise<any>} returns a Promise that resolves when all values have been processed, or false was returned from valueCallback
//      */
//     next(valueCallback) {
//         this.callback = cb;
//         this.start();
//         const promise = new Promise((resolve, reject) => { 
//             this.resolve = resolve; 
//             this.reject = reject; 
//         });
//         return promise;
//     }    
// }

module.exports = {
    Node,
    NodeAddress,
    NodePath,
};