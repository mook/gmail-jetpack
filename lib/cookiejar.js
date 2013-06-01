"use strict";

const { Cu, Ci } = require("chrome");
const { Class } = require('sdk/core/heritage');

/**
 * Short hand for safe Object.hasOwnProperty
 */
const has = (obj, prop) => Object.hasOwnProperty.call(obj, prop);

/**
 * Short hand for defaultdict-like behaviour
 */
const get = (obj, key, def={}) => obj[key] = has(obj, key) ? obj[key] : def;

exports.CookieJar = Class({
    initialize: function(args) {
        // Domain map, by reverse order of the host
        // e.g. this._jar.com.example
        // per-host jars are keyed by "." (since it's invalid as a domain piece)
        // empty string means cookies for all sub-domains
        // from there it's cookie name -> path -> array of cookie objects
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
            let domain = cookie.domain;
            if (!domain) {
                return fqdn; // no domain set
            }
            if (!cookie.expires) {
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
        } catch (e if e instanceof String) {
            console.log("Rejecting cookie", cookie.name, ":", e);
            return;  // Bad domain
        }
        let jar = this._jar;
        // Walk the jar to the most specific part
        if (pieces.slice(-1)[0] != "") {
            pieces.push("."); // last piece not empty, this is a fqdn
        }
        for (piece of pieces) {
            jar = get(jar, piece);
        }
        if (cookie.expired) {
            delete get(jar, cookie.name)[cookie.path];
            if (Object.keys(jar[cookie.name]).length < 1) {
                delete jar[cookie.name];
            }
        } else {
            get(jar, cookie.name)[cookie.path] = cookie;
        }
    },
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
function Cookie(args) {
    for (let key of Object.keys(args)) {
        this[key] = args[key];
    }
    if ("expires" in args) {
        this.expires = Date.parse(args.expires);
    }
}
Cookie.prototype.toString = () => this.value;
/**
 * Check if this cookie should apply to the given URL
 * @param url {sdk/url::URL} The URL to check
 * @returns {Boolean}
 */
Cookie.prototype.appliesTo = function(url) {
    if (this.expired) {
        return false;
    }
    
};
Object.defineProperty(Cookie.prototype, "expired", {
    get: () => this.expires ? Date.now() < this.expires : false,
    enumerable: true});

exports.Cookie = Cookie;
