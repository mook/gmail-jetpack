"use strict";

const { Cc, Ci } = require("chrome");
const { Class } = require('sdk/core/heritage');

/**
 * Short hand for safe Object.hasOwnProperty
 */
const has = (obj, prop) => Object.hasOwnProperty.call(obj, prop);

/**
 * Short hand for defaultdict-like behaviour
 */
const get = (obj, key, def={}) => obj[key] = has(obj, key) ? obj[key] : def;

const CookieJar = exports.CookieJar = Class({
    initialize: function(args) {
        // Domain map, by reverse order of the host
        // e.g. this._jar.com.example
        // per-host jars are keyed by "." (since it's invalid as a domain piece)
        // empty string means cookies for all sub-domains
        // from there it's cookie name -> path -> cookie
        this._jar = {};
    },
    /**
     * Add a cookie to the cookie jar
     * @oaram cookie {Cookie} The cookie to add
     * @param url {sdk/url::URL} The URL of the request
     */
    add: function(cookie, url) {

        /**
         * Helper function to get the domain this cookie should apply to
         * @returns {String} The domain to use
         *
         * Based on RFC 2109
         */
        function getDomain() {
            let fqdn = url.host;
            if (!fqdn) {
                throw "URL has no host, not supported";
            }
            let domain = cookie.domain;
            if (!domain || domain == fqdn) {
                return fqdn; // no domain set
            }
            if (false && !cookie.expires) {
                throw "Session cookies cannot have a domain";
            }
            if (!domain.startsWith(".")) {
                throw "Domains must start with a dot";
            }
            if (fqdn.split(".", 1) + domain != fqdn) {
                throw "Host has subdomains, or domain not suffix of host";
            }
            // Make sure the domain isn't an eTLD
            let eTLDSvc = Cc["@mozilla.org/network/effective-tld-service;1"]
                            .getService(Ci.nsIEffectiveTLDService);
            try {
                let baseDomain = eTLDSvc.getBaseDomainFromHost("h" + domain);
                if (!domain.endsWith("." + baseDomain)) {
                    throw "Domain is not inproper setbset of eTLD";
                }
            } catch(e) {
                throw "Domain is invalid / less than an eTLD"
            }
            // Looks okay
            return domain;
        }
        
        try {
            var pieces = getDomain().split(".").reverse();
        } catch (e) {
            console.log("Rejecting cookie", cookie.name, ":", e);
            return;  // Bad domain
        }
        let jar = this._jar;
        // Walk the jar to the most specific part
        if (pieces.slice(-1)[0] != "") {
            pieces.push("."); // last piece not empty, this is a fqdn
        }
        for (let piece of pieces) {
            jar = get(jar, piece);
        }
        if (cookie.expired) {
            console.log("Removing expired cookie", cookie);
            delete get(jar, cookie.name)[cookie.path];
            if (Object.keys(jar[cookie.name]).length < 1) {
                delete jar[cookie.name];
            }
        } else {
            get(jar, cookie.name)[cookie.path] = cookie;
        }
    },

    /**
     * Get the cookies appropriate for a given URL
     * @param url {sdk/url::URL} The URL to look up
     * @return {Array of Cookie} cookies to send
     */
    get: function(url) {
        let results = {};
        let fqdn = url.host;
        if (!fqdn) {
            return result; // We don't support hostless URLs
        }

        /**
         * update results from the given sub-jar (i.e. wildcard/host-specific)
         * @param subjar {Object} hash with paths as keys
         */
        let update = (subjar) => {
            for (let name of Object.keys(subjar)) {
                // Get all paths, sorted longest first
                let paths = Object.keys(subjar[name]).sort((a, b) =>
                    (b.length - a.length) || a.localeCompare(b));
                for (let path of paths) {
                    if (url.path.startsWith(path)) {
                        // clobber existing results with values from this path
                        let cookie = subjar[name][path];
                        if (cookie.expired) {
                            delete subjar[name][path];
                        } else if (cookie.secure && url.scheme == "http") {
                            continue; // ignore secure cookies for http
                        } else {
                            results[name] = subjar[name][path];
                            break; // No more cookies with this name in this subjar
                        }
                    }
                }
            }
        };
        let jar = this._jar;
        for (let piece of fqdn.split(".").reverse()) {
            if (!has(jar, piece)) {
                break; // No better matches
            }
            jar = jar[piece];
            if (has(jar, "")) {
                // has a wildcard jar, ".example.com"
                update(jar[""]);
            }
        }
        if (has(jar, ".")) {
            // has a host-specific jar, "www.example.com"
            update(jar["."]);
        }
        return [results[name] for (name of Object.keys(results))];
    },

    toString: function() 
        "<CookieJar: " +
        [JSON.stringify(this[domain]) for (domain of Object.keys(this))].join(", ") +
        ">",
});


/**
 * Create a cookie object
 * Input is a dict, should have the same things as cookie properties:
 * name {String} The name of the cookie
 * value {String} The value of the cookie
 * secure {Boolean}
 * httpOnly {Boolean}
 * path {String} (optional)
 * domain {String} (optional)
 * expires {String} (optional) -> This gets converted to a number as in Date.valueOf()
 */

const Cookie = exports.Cookie = Class({
    initialize: function (args) {
        if (!has(args, "value")) {
            args.value = ""; // Meh...
        }
        for (let key of Object.keys(args)) {
            this[key] = args[key];
        }
        if ("expires" in args) {
            this.expires = Date.parse(args.expires);
        }
    },
    
    toString: function() [this.name, this.value].join("="),

    get expired() this.expires ? Date.now() > this.expires : false,
});
