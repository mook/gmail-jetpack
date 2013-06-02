"use strict";

const { Cc, Ci, Cu } = require("chrome");
const self = require("self");
const { storage } = require("sdk/simple-storage");
const passwords = require("sdk/passwords");
const { Class } = require('sdk/core/heritage');
const { URL } = require("sdk/url");
const { RequestPromise } = require("./request");
const { CookieJar } = require("./cookiejar");
const { defer, reject } = require("sdk/core/promise");

/**
 * Data for a gmail account
 */
const Account = exports.Account = Class({
    initialize: function (username) {
        /**
         * The full account name, "user@example.org"
         */
        this.username = username;
        /**
         * Data regarding the number of unread mail for each label; the key
         * is the label name ("Inbox", "Spam", "eggs"), and the value is
         * a hash of:
         *  "unread" -> {Number} unread count
         *  "total" -> {Number} total mail, or NaN for unknown
         */
        this.labels = {};
        console.log("Creating account:", this.username);
        this.cookiejar = new CookieJar();
        this.button = require("toolbarbutton").ToolbarButton({
            id: self.id + ":toolbar:" + this.username,
            label: this.username,
            image: self.data.url("images/offline.png"),
            tooltiptext: this.username,
            onCommand: () => this.check(),
        });
        if (!(this.username in storage)) {
            // new account
            storage[this.username] = {
                "auto-login": true,
            };
            this.button.moveTo({
                toolbarID: "addon-bar",
                forceMove: false,
            });
        }
        
        if (storage[this.username]["auto-login"]) {
            this.check();
        }
    },

    /**
     * Fetch a URL, and does an automatic login if it seems necessary
     * @param opts {Object} Same as ./request::Request
     * @yields {Document}
     */
    loginPromise: function(opts) {
        let isLoginURL = (url) =>
            (url.origin == this._loginURL.origin && url.pathname == this._loginURL.pathname);

        if (isLoginURL(opts.url)) {
            throw "Can't use loginPromise with the login URL!";
        }
        return RequestPromise(opts)
        .then((loginRequestDoc) => {
            let loginRequestURL = new URL(loginRequestDoc.documentURI);
            if (!isLoginURL(loginRequestURL)) {
                console.log("Got", loginRequestURL, "is not login url",
                            this._loginURL,
                            "origin:", loginRequestURL.origin, "/", this._loginURL.origin,
                            "path:", loginRequestURL.path, "/", this._loginURL.path,
                            JSON.stringify(loginRequestURL));
                return loginRequestDoc; // Done logins, probably
            }

            let deferred = defer();

            require("sdk/passwords").search({
                username: this.username,
                url: "https://accounts.google.com",
                onComplete: deferred.resolve,
                onError: deferred.reject,
            });

            return deferred.promise.then((logins) => {
                console.log("Have password for", this.username);
                return logins[0].password;
            }).then((password) => {
                let form = loginRequestDoc.querySelector('form[action][method]');
                let data = {};
                for (let input of form.querySelectorAll('input')) {
                    let name = input.getAttribute("name");
                    let type = input.getAttribute("type");
                    let value = input.value;
                    if (name == "Email" || type == "email") {
                        value = this.isHosted ? this.user : this.username;
                    } else if (type == "password") {
                        value = password;
                    }
                    data[name] = value;
                }
                delete data.PersistentCookie;
                console.log("Sending login request...");
                return RequestPromise({
                    url: new URL(form.getAttribute("action"), loginRequestURL),
                    method: form.getAttribute("method") || "POST",
                    cookiejar: this.cookiejar,
                    data: data,
                    referrer: loginRequestURL.toString(),
                });
            }).then((doc) => {
                console.log("Possibly logged in...");
                let cookies = this.cookiejar.get(this._loginURL);
                if (isLoginURL(doc.documentURI)) {
                    throw "Login loop";
                }
                return doc;
            }).then((doc) => {
                this.button.image = self.data.url("images/online.png");
                return doc;
            }).then(null, (error) => {
                console.exception(error);
                this._on_logout();
                reject(error);
            });
        });
    },
    
    check: function() {
        this.loginPromise({
            url: this._checkURL,
            method: "GET",
            cookiejar: this.cookiejar,
        }).then((doc) => {
            // Have a document, look for the global data <script> block
            // XXX Mook: GLOBALS= VIEW_DATA=
            for (let elem of doc.querySelectorAll(":root > body > script")) {
                let script = elem.textContent;
                if (/\bGLOBALS\s*=/.test(script)) {
                    this._check_labels(script);
                } else if (/\bVIEW_DATA\s*=/.test(script)) {
                    this._check_snippets(script);
                }
            }
            console.log(JSON.stringify(this.labels));
        }).then(null, (error) => {
            console.error(error);
            this._on_logout();
        });
    },

    /**
     * Given some script text, evaluate it and return a variable in the global
     * script in the sandbox.
     * @param script {String} The script text to evaluate
     * @oaram prop {String} The name of the (script-local) global variable to
     *      return; if not given, the script global object itself is returned.
     * @param defaultVal {any} The default value to return if not found
     */
    _eval_in_sandbox: function(script, prop="", defaultVal={}) {
        // Make a blank sanbox to eval in (it _will_ throw...)
        let sandbox = new Cu.Sandbox("about:blank", {
            sandboxName: self.id + " evaluate: " + this.username,
            wantComponents: false});
        try {
            Cu.evalInSandbox(script, sandbox);
        } catch(e) {
            // Expected to throw
        }

        let obj = null;
        if (!prop) {
            obj = sandbox;
        } else if (prop in sandbox) {
            obj = sandbox[prop];
        } else {
            obj = defaultVal;
        }
        // JSON serialize it to make sure we end up with safe data
        obj = JSON.parse(JSON.stringify(obj));
        Cu.nukeSandbox(sandbox);
        return obj;
    },

    /**
     * Helper for check(): Given global data script text, find the labels /
     * unread counts / totals
     */
    _check_labels: function(script) {
        let globals = this._eval_in_sandbox(script, "GLOBALS", []);

        if (!Array.isArray(globals)) {
            throw "Mailbox global data is not an array";
        }
        // The interesting data is the (only) child of globals that is
        // itself an array of array
        for (let child of globals) {
            if (Array.isArray(child) && Array.isArray(child[0])) {
                globals = child;
                break;
            }
        }
        let data = {};
        for (let child of globals) {
            data[child[0]] = child.slice(1);
        }

        let label_mapping = {
            // See Android documentation of GmailContract.Labels.LabelCanonicalNames
            // https://developers.google.com/gmail/android/com/google/android/gm/contentprovider/GmailContract.Labels.LabelCanonicalNames
            "^all": "All Mail",
            "^r": "Drafts",
            "^i": "Inbox",
            "^iim": "Priority Inbox",
            "^f": "Sent Mail",
            "^s": "Spam",
            "^t": "Starred",
            "^k": "Trash",
            // Stuff found via typing them into the search box...
            "^b": "Chats",
            "^ig": "Priority Inbox",
            "^io_im": "Important",
            "^sl_root": "Categories",
            "^u": "Unread",
        };

        if ("sld" in data) {
            // Smart label data?  We need to collapse the first level of arrays
            let smart_label_collection = data.sld.reduce((p, c) => p.concat(c), []);
            for (let smart_label of smart_label_collection) {
                // Array of [canonical name, display name, ??? other stuff]
                label_mapping[smart_label[0]] = smart_label[1];
            }
        }

        // Other interesting things in here: (best guesses)
        // "qu": quota data (space usage and total, both in megabytes)
        // "la": concurrent logins
        // "ll": user UI language preference
        // "cfs": alternative senders (custom from strings?)

        if (!("ld" in data)) {
            throw "Can't find label data";
        }
        // data.ld is a bunch of chunks; we don't care about the
        // difference between chunks, so let's mash them together
        let label_data_collection = data.ld.reduce((p, c) => p.concat(c), []);
        let labels = {};
        for (let label_data of label_data_collection) {
            // Another array of unknown format; the first three items
            // seem to be label-name, unread-count, total-count.
            let label = label_data[0];
            if (label in label_mapping) {
                label = label_mapping[label];
            }
            // Special labels have -1 instead of 0 sometimes... presumably
            // that means unknown.  Treat them as 0.
            labels[label] = {
                unread: Math.max(label_data[1], 0),
                total: Math.max(label_data[2], 0),
            };
        }
        this.labels = labels;
    },

    /**
     * Helper for check(): Given view data script text, parse out the snippets
     * we were given.
     */
    _check_snippets: function(script) {
    },

    /**
     * Called when the account has been logged out
     */
    _on_logout: function() {
        this.button.image = self.data.url("images/offline.png");
        // Clear cookies
        this.cookiejar = new CookieJar();
    },
    
    /**
     * The domain of this account
     */
    get domain() this.username.replace(/^.*@/, ""),
    
    /**
     * The user name for this account
     */
    get user() this.username.replace(/@.*?$/, ""),
    
    /**
     * Whether this account is o Google Apps for Domain account
     */
    get isHosted() ["gmail.com", "googlemail.com"].indexOf(this.domain) < 0,
    
    /**
     * The URL to use for logging in
     */
    get _loginURL() this.isHosted ?
        URL("https://www.google.com/a/" + this.domain + "/ServiceLogin") :
        URL("https://accounts.google.com/ServiceLoginAuth"),
    
    /**
     * The URL to use for checking mail
     */
    get _checkURL() this.isHosted ?
        URL("https://mail.google.com/a/" + this.domain + "/") :
        URL("https://mail.google.com/mail/"),
});