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
const { validateOptions } = require("sdk/deprecated/api-utils");
const { open } = require("sdk/tabs");
const windowUtils = require("sdk/deprecated/window-utils");
const { Services } = Cu.import("resource://gre/modules/Services.jsm");
const querystring = require("sdk/querystring");

/**
 * Short hand for safe Object.hasOwnProperty
 */
const has = (obj, prop) => Object.hasOwnProperty.call(obj, prop);

/**
 * Short hand for defaultdict-like behaviour
 */
const get = (obj, key, def={}) => obj[key] = has(obj, key) ? obj[key] : def;

/**
 * Data for a gmail account
 */
const Account = exports.Account = Class({
    STATE: {
        /**
         * The account is logged out.
         */
        OFFLINE: {
            image: self.data.url("images/offline.png"),
        },
        /**
         * The account is in the progress of connecting
         */
        CONNECTING: {
            image: self.data.url("images/busy.png"),
        },
        /**
         * The account is logged in; there are no unread messages.
         */
        ONLINE: {
            image: self.data.url("images/online.png"),
        },
        /**
         * The account is logged in; there are unread messages.
         */
        NOTIFY: {
            image: self.data.url("images/notify.png"),
        },
    },

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
        /**
         * The snippets we know about
         */
        this.snippets = [];
        /**
         * The URL to actually use for opening the inbox.  We find this out by
         * doing the mail checking and then following all the redirects until
         * we actually get to the mailbox.  See comment in open().
         */
        this.openURL = "";

        console.log("Creating account:", this.username);
        this.cookiejar = new CookieJar();
        this.button = require("toolbarbutton").ToolbarButton({
            id: self.id + ":toolbar:" + this.username,
            label: this.username,
            image: this.STATE.CONNECTING.image,
            tooltiptext: this.username,
            onCommand: () => this._on_button_click(),
        });

        let accounts = get(storage, "accounts", {});
        if (!(this.username in accounts)) {
            // new account
            this.button.moveTo({
                toolbarID: "addon-bar",
                forceMove: false,
            });
        }

        this.state = this.STATE.OFFLINE;

        this.prefs = get(accounts, this.username, {});
        if (get(this.prefs, "auto-login", false)) {
            this.check();
        }
    },

    set state(v) {
        this._state = v;
        this.button.image = v.image;
    },

    get state() this._state,

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
                if (isLoginURL(doc.documentURI)) {
                    throw "Login loop";
                }
                return doc;
            }).then(null, (error) => {
                console.exception(error);
                this._on_logout();
                reject(error);
            });
        });
    },
    
    check: function() {
        this.state = this.STATE.CONNECTING;
        this.loginPromise({
            url: this._checkURL,
            method: "GET",
            cookiejar: this.cookiejar,
        }).then((doc) => {
            this.openURL = doc.documentURI;
            // Have a document, look for the global data <script> block
            for (let elem of doc.querySelectorAll(":root > body > script")) {
                let script = elem.textContent;
                if (/\bGLOBALS\s*=/.test(script)) {
                    this._check_labels(script);
                } else if (/\bVIEW_DATA\s*=/.test(script)) {
                    this._check_snippets(script);
                }
            }
            console.log(JSON.stringify(this.snippets));
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
                //label = label_mapping[label];
            }
            // Special labels have -1 instead of 0 sometimes... presumably
            // that means unknown.  Treat them as 0.
            labels[label] = {
                unread: Math.max(label_data[1], 0),
                total: Math.max(label_data[2], 0),
            };
        }
        this.labels = labels;

        this.state = get(get(labels, "^i", {}), "unread", 0) > 0 ?
            this.STATE.NOTIFY :
            this.STATE.ONLINE;
    },

    /**
     * Helper for check(): Given view data script text, parse out the snippets
     * we were given.
     */
    _check_snippets: function(script) {
        let viewData = this._eval_in_sandbox(script, "VIEW_DATA", []);
        if (!Array.isArray(viewData)) {
            throw "view data is not an array";
        }
        // Arrgh. viewData is the usual first-item-is-string-id deal, but there
        // can be multiple "tb" (snippet data?) entries.
        let snippets = [];
        for (let viewDatum of viewData) {
            if (!Array.isArray(viewDatum)) {
                continue; // Not an array?
            }
            if (viewDatum[0] != "tb") {
                continue; // Not snippet data
            }
            // Three item array, "tb", offset for pagination, and array of snippets
            let snippetList = viewDatum[2];
            if (!Array.isArray(snippetList)) {
                continue; // Doesn't look right
            }
            for (let snippet of snippetList) {
                if (!Array.isArray(snippet)) {
                    continue;
                }
                let {     0: conversationId, // id of first mail in conversation?
                      //  1: some sort of mail id
                      //  2: some sort of mail id
                          3: isRead,
                          4: isStarred,
                      //  5: visible tags this conversation is in?
                      //  6: all tags, including hidden system ones, this conversation is in?
                          7: peopleHtml, // HTML for the people-involved column
                      //  8: html for the importance marker (yellow [> shaped things)]
                          9: subjectHtml, // HTML for the subject
                         10: bodyHtml, // mail body snippet HTML
                      // 11: unknown
                      // 12: unknown
                         13: attachmentFileNames,
                         14: dateHtml, // short date, e.g. 2/28/95
                         15: time, // message time, as a full date
                      // 16: last check time? in microseconds-from-epoch
                      // 17: unknown,
                      // 18: unknown,
                      // 19: unknown,
                      // 20: unknown,
                      // 21: unknown,
                      // 22: unknown,
                      // 23: unknown,
                      // 24: unknown,
                      // 25: unknown,
                      // 26: unknown,
                      // 27: unknown,
                      // 28: last from address in conversation? reply-to?
                      // 29: unknown,
                      // 30: unknown,
                      // 31: unknown,
                      // 32: unknown,
                    } = snippet;
                console.log("conversation id:", conversationId)
                try {
                    let message = new Message({
                        conversationId: conversationId,
                        isRead: isRead,
                        isStarred: isStarred,
                        people: stripHTML(peopleHtml),
                        subject: stripHTML(subjectHtml),
                        body: stripHTML(bodyHtml),
                        attachments: [attachmentFileNames],
                        time: new Date(String(time).replace(/\bat\b/, "")),
                    });
                    snippets.push(message);
                } catch(e) {
                    console.exception(e);
                }
            }
        }
        this.snippets = snippets;
    },

    /**
     * Called when the account has been logged out
     */
    _on_logout: function() {
        this.state = this.STATE.OFFLINE;
        // Clear cookies
        this.cookiejar = new CookieJar();
    },

    /**
     * Event handler for toolbar button click
     */
    _on_button_click: function() {
        try {
            switch (this.state) {
                case this.STATE.OFFLINE:
                    this.check();
                    break;
                case this.STATE.ONLINE:
                case this.STATE.NOTIFY:
                    this.open();
                    break;
                case this.STATE.CONNECTING:
                    // Already busy
                    // We should 1) abort current requests; 2) re-start check
                    // But we don't have laod groups yet, so do nothing for now
                    break;
            }
        } catch(e) {
            console.exception(e);
        }
    },

    /**
     * Open this account in a browser tab
     */
    open: function() {
        // We need to use the post-redirect URL from all the loading to avoid
        // getting a login prompt in our face.  Hopefully we already have that
        // from checking for new mail; if not, use the default (which will get
        // us a login prompt, ah well).
        let url = this.openURL ? new URL(this.openURL) : this._checkURL;
        let channel = Services.io.newChannel(url, null, null)
                              .QueryInterface(Ci.nsIHttpChannelInternal)
                              .QueryInterface(Ci.nsIPrivateBrowsingChannel);
        // Force allow "third party" cookies, since we don't have a window
        channel.forceAllowThirdPartyCookie = true;

        if (self.isPrivateBrowsingSupported) {
            // Inject the cookies into the private browsing context
            channel.setPrivate(true);
        } else {
            // inject the cookies into whatever the active window is
            let isPrivate = windowUtils.activeBrowserWindow
                                       .QueryInterface(Ci.nsIInterfaceRequestor)
                                       .getInterface(Ci.nsIWebNavigation)
                                       .QueryInterface(Ci.nsILoadContext)
                                       .usePrivateBrowsing;
            channel.setPrivate(isPrivate);
        }

        // Inject the cookies according to the given channel
        let cookieSvc = Cc["@mozilla.org/cookieService;1"]
                          .getService(Ci.nsICookieService);
        for (let cookie of this.cookiejar.get(url)) {
            // the cookie might be HttpOnly; pretend we're from HTTP.
            cookieSvc.setCookieStringFromHttp(channel.URI,
                                              channel.URI,
                                              null,
                                              cookie.toString(),
                                              "",
                                              channel);
        }
        // Cookies are set, load the new page
        open({url: url.toString(),
              isPrivate: true,
              });
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

/**
 * Given some document fragment source string,
 * discard the HTML and return raw text
 */
function stripHTML(html) {
    // This is slow, but we don't care for now
    try {
        return Cc["@mozilla.org/xmlextras/domparser;1"]
                 .createInstance(Ci.nsIDOMParser)
                 .parseFromString(html, "text/html")
                 .documentElement
                 .textContent;
    } catch(e) {
        console.exception(e);
        return "";
    }
}

const Message = Class({
    initialize: function(args) {
        args = validateOptions(args, {
            conversationId: {
                is: ["string"],
            },
            isRead: {
                map: (v) => !!v,
            },
            isStarred: {
                map: (v) => !!v,
            },
            people: {
                is: ["string"],
            },
            subject: {
                is: ["string"],
            },
            body: {
                is: ["string"],
            },
            attachments: {
                is: ["array"],
                ok: (v) => v.every((e) => (typeof e) == "string"),
            },
            time: {
                is: ["object"],
                ok: (v) => v instanceof Date,
            },
        });
        for (let key of Object.keys(args)) {
            this[key] = args[key];
        }
    },
});