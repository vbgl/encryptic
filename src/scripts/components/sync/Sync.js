/**
 * @module components/sync/Sync
 */
import Radio from 'backbone.radio';
import _ from 'underscore';
import deb from 'debug';
import RemoteStorageSync from './remotestorage/RemoteStorage';
import DropboxSync from './Dropbox';

const log = deb('lav:components/sync/Sync');

/**
 * Cloud syncing
 *
 * @class
 * @license MPL-2.0
 */
export default class Sync {

    /**
     * Radio channel.
     *
     * @prop {Object}
     */
    get channel() {
        return Radio.channel('components/sync');
    }

    /**
     * App settings.
     *
     * @prop {Object}
     */
    get configs() {
        return Radio.request('collections/Configs', 'findConfigs');
    }

    /**
     * Names of the collections which should be synchronized.
     *
     * @prop {Array}
     */
    get collectionNames() {
        return ['Notes', 'Notebooks', 'Tags', 'Files'];
    }

    /**
     * Profile id.
     *
     * @prop {String}
     */
    get profileId() {
        return Radio.request('collections/Profiles', 'getProfile');
    }

    constructor(sync) {
        /**
         * Sync cloud instance
         *
         * @prop {Object}
         */
        if (sync === 'remotestorage') {
            this.cloud = new RemoteStorageSync(this.configs);
        }
        else if (sync === 'dropbox') {
            this.cloud = new DropboxSync(this.configs);
        }
        else {
            log('error: invalid sync method');
            return false;
        }

        /**
         * Sync stats.
         *
         * @prop {Object}
         */
        this.stat = {
            interval    : 2000,
            intervalMax : 15000,
            intervalMin : 2000,
        };

        this.channel.reply({
            start      : this.start,
            disconnect : this.disconnect,
        }, this);
    }

    /**
     * Initialize synchronization.
     *
     * @returns {Promise}
     */
    async init() {
        try {
            const authenticated = await this.cloud.checkAuth();
            if (authenticated) {
                return this.start();
            }
            log('Authentication failed');
        }
        catch (e) {
            log('Cloud auth error', e);
        }
    }

    /**
     * Start synchronizing.
     */
    start() {
        this.stopWatch();
        this.timeout = setTimeout(() => this.sync(), 500);
    }

    /**
     * Schedule a new check.
     */
    startWatch() {
        this.stopWatch();
        this.timeout = window.setTimeout(() => this.sync(), this.getInterval());
    }

    /**
     * Compute the wait time for the watchdog.
     *
     * @returns {Number}
     */
    getInterval() {
        const range = this.stat.intervalMax - this.stat.intervalMin;

        if (this.stat.statRemote) {
            this.stat.interval -= (range * 0.4);
        }
        else {
            this.stat.interval += (range * 0.2);
        }

        this.stat.interval = Math.max(this.stat.intervalMin, this.stat.interval);
        this.stat.interval = Math.min(this.stat.intervalMax, this.stat.interval);
        log(`next check is after ${this.stat.interval}ms`);
        return this.stat.interval;
    }

    /**
     * Stop a check.
     */
    stopWatch() {
        if (this.timeout) {
            window.clearTimeout(this.timeout);
        }
    }

    /**
     * Synchronize all collections.
     *
     * @returns {Promise}
     */
    sync() {
        let promise = Promise.resolve();
        this.channel.trigger('start');
        this.stat.statRemote = false;
        log('checking for changes...');

        _.each(this.collectionNames, name => {
            promise = promise.then(() => this.syncCollection(name));
        });

        return promise
        .then(() => {
            this.channel.trigger('stop', {result: 'success'});
            this.startWatch();
        })
        .catch(error => {
            log('sync error', error);
            this.channel.trigger('stop', {result: 'error', error});
        });
    }

    /**
     * Synchronize a collection.
     *
     * @param {String} name - Notes, Notebooks, Files, Tags...
     * @returns {Promise}
     */
    async syncCollection(name) {
        const collection = await Radio.request(`collections/${name}`, 'find');
        const files      = await this.cloud.find({
            type      : collection.storeName,
            profileId : this.profileId,
        });
        const data = {files, collection: collection.fullCollection || collection};

        await this.syncRemoteChanges(data);
        await this.syncLocalChanges(data);
    }

    /**
     * Save remote changes locally.
     *
     * @param {Array} files
     * @param {Object} collection - Backbone model
     * @returns {Promise}
     */
    syncRemoteChanges({files, collection}) {
        const promises = [];
        _.each(files, file => {
            const model = collection.findWhere({id: file.id});

            if (!model || model.get('updated') < file.updated) {
                this.stat.statRemote = true;
                const mdl = promises.push(collection.channel.request('saveModelObject', {
                    data      : file,
                    profileId : this.profileId,
                }));
                Radio.trigger('components/notes', 'save:model', {model: mdl});
            }
        });

        return Promise.all(promises);
    }

    /**
     * Synchronize local changes with a cloud storage.
     *
     * @param {Array} files
     * @param {Object} collection - Backbone model
     * @returns {Promise}
     */
    syncLocalChanges({files, collection}) {
        const promises = [];

        collection.each(model => {
            const file = _.findWhere(files, {id: model.id});

            if (!file || file.updated < model.get('updated')) {
                promises.push(
                    this.cloud.saveModel({model, profileId: this.profileId})
                );
            }
        });

        return Promise.all(promises);
    }

    /**
     * Disconnect the cloud server
     *
     * @returns {Promise}
     */
    disconnect() {
        this.stopWatch();

        if (_.isFunction(this.cloud.disconnect)) {
            return this.cloud.disconnect();
        }

        return Promise.resolve();
    }
}
