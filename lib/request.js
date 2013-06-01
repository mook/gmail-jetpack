/**
 * Requests that force specific sets of cookies
 * This is _not_ modeled after jetpack's sdk/requests; do not confuse the APIs.
 */
"use strict";

const { Class } = require('sdk/core/heritage');
const { Unknown } = require('sdk/platform/xpcom');
const { Cc, Ci, Cr, Cu } = require("chrome");
const { XMLHttpRequest } = require("sdk/net/xhr");
const { defer } = require("sdk/core/promise");
const { validateOptions } = require("sdk/deprecated/api-utils");

Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/XPCOMUtils.jsm");

XPCOMUtils.defineLazyModuleGetter(this, "NetworkHelper",
                                  "resource://gre/modules/devtools/NetworkHelper.jsm");

const { CookieJar, Cookie } = require("./cookiejar");

/**
 * Create a request; all options other than url are optional.
 * @param url {String} The URL to open
 * @param private {Boolean} Is this request private? Defaults to true.
 * @param cookiejar {./cookiejar::CookieJar} The cookie jar to use
 * @param method {String} One of GET or POST; default is GET.
 */
const Request = exports.Request = Class({
    initialize: function (opts) {
        console.log("making new request:", JSON.stringify(opts));
        opts = validateOptions(opts, {
            url: {
                map: (v) => v && v instanceof Ci.nsIURL ? v.spec : String(v).valueOf(),
                is: ["string"],
            },
            "private": {
                map: (v) => v === undefined ? true : !!v,
                is: ["boolean"],
            },
            cookiejar: {
                map: (v) => v || new CookieJar(),
                ok: (v) => v instanceof CookieJar,
            },
            method: {
                map: (v) => String(v).toUpperCase().valueOf(),
                ok: (v) => ["GET", "PUT"].indexOf(v) >= 0,
            },
        });

        this.cookiejar = opts.cookiejar;
        this.xhr = new XMLHttpRequest({mozAnon: opts["private"], mozSystem: true});
        this.xhr.addEventListener("load", this._onload.bind(this), false);
        this.xhr.open(opts.method, opts.url, /*async*/ true);
        this.xhr._req.responseType = "document";
        let channel = this.xhr._req.channel
                          .QueryInterface(Ci.nsIHttpChannelInternal)
                          .QueryInterface(Ci.nsIPrivateBrowsingChannel);
        
    
        // Setting a load group makes impossible to go private; see bug 877961
        //if (!channel.loadGroup) {
        //    channel.loadGroup = Cc["@mozilla.org/network/load-group;1"]
        //                          .createInstance(Ci.nsILoadGroup);
        //}
    
        channel.setPrivate(opts["private"]);
        this.xhr._req.setRequestHeader("Cookie", this.cookiejar.get(channel.URI).join(";"));
        this.xhr.send();
    },

    _storeCookies: function() {
        let cookieHeader = this.xhr.getResponseHeader("Set-Cookie");
        if (!cookieHeader) {
            return;
        }
        console.log("raw cookies:", cookieHeader);
        let cookies = NetworkHelper.parseSetCookieHeader(cookieHeader);
        for (let cookie of cookies) {
            console.log("cookie:", JSON.stringify(cookie));
            this.cookiejar.add(new Cookie(cookie), this.xhr._req.channel.URI);
        }
    },

    _onload: function()  {
        try {
            this._storeCookies();
            console.log("load!", this.xhr._req.response, "::", this.cookiejar);
        } catch(e) {
            console.exception(e);
        }
    },

    addEventListener: function(name, listener, capture)
        this.xhr._req.addEventListener(name, listener, capture),
});

/**
 * Promise-style request; takes the same arguments as a Request
 */
const RequestPromise = exports.RequestPromise = function(options) {
    let deferred = defer();
    let req = new Request(options);
    let succeeded = false;
    req.addEventListener("load", function(event) {
        deferred.resolve(req.xhr._req.response);
    }, false);
    req.addEventListener("loadend", function(event) {
        deferred.reject(event); // does nothing if already resolved
    }, false);
    return deferred.promise;
};
