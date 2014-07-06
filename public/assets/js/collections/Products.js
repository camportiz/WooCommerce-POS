define(['underscore', 'backbone', 'backbone-paginator', 'models/Product', 'settings', 'db/ProductsDB'], 
	function(_, Backbone, PageableCollection, Product, Settings, Database){
	
	// the pageable product list
	var Products = Backbone.PageableCollection.extend({
		database: Database,
		storeName: 'products',
		model: Product,
		mode: 'client',
		params: pos_params,

		state: {
			pageSize: 5,
			totalRecords: null,
			sortKey: "updated_at",
    		order: 1
  		},

		initialize: function( models, options ) {
			// this.on('all', function(e) { console.log("Product Collection event: " + e); }); // debug

			// pubsub
			this.pubSub = options.pubSub;

			this.listenTo( options.pubSub, 'serverSync', this.serverSync );

			// sync on init
			this.serverSync();
		},

		/**
		 * Sync the local database with the server
		 * TODO: improve product audit, maybe move to worker?
		 */
		serverSync: function() {
			var self = this;

			$('#pagination').addClass('working');

			// first audit the products, delete any that have been removed from the server
			this.auditProducts()
			.then( function( productArray ) {
				if( productArray.length > 0 ) { 
					return self.removeProducts( productArray ); 
				}
			})

			// then: start the web worker sync
			.then( function(){

				self.startWorker();
			});
		},

		/**
		 * Opens a modal window with progress bar for serverSync
		 */
		showModal: function( modal, msg ) {
			if( typeof msg === 'undefined' ) msg = '';

			switch ( modal ) {
				case 'downloadProgress':
					$.get( pos_params.ajax_url , { action: 'pos_get_modal', template: 'download-progress', data: { total: msg } } )
					.done(function( data ) {
						$(data).modal();
					});
				break;
				case 'error':
					$.get( pos_params.ajax_url , { action: 'pos_get_modal', template: 'error' } )
					.done(function( data ) {
						$(data).modal().find('.modal-body').html(error[msg]);
					});
				break;
				default:
			}
			// ajax call to get the modal template
			
		},

		/**
		 * Clear the database
		 */
		clear: function() {
			var self = this;

			// Danger! This call should never go out to the server. It's not a problem at
			// the moment but checks and balances should be added if WC REST API allows delete
			Backbone.sync('delete', this, {
				success: function() {
					self.fullCollection.reset();
					Settings.set( 'last_update', null );
				},
				error: function() {
					alert('There was a problem clearing the database');
				}
			});
		},

		/**
		 * Start the product sync in the background
		 */
		startWorker: function() {
			var self = this;

			// start a web worker
			var worker = new Worker( this.params.worker );

			worker.addEventListener('message', function(e) {
				var status = e.data.status;

				switch (status) {
					case 'progress':
						// if modal is open, update the progress bar
						if( $('#download-progress').hasClass('in') ) {
							$('#download-progress').find('.progress-bar').data('count', e.data.count).trigger('changeData');
						}
						self.fetch();
					break;
					case 'error':
						self.showModal('error', e.data.msg);
						Settings.set( 'last_update', Date.now() );
						self.trigger('sync'); // trigger sync to update last_update display
						$('#pagination').removeClass('working');
					break;
					case 'complete':
						console.log(e.data.msg);
						Settings.set( 'last_update', Date.now() );
						self.trigger('sync'); // trigger sync to update last_update display
						$('#pagination').removeClass('working');
					break;
					case 'showModal': 
						self.showModal(e.data.type, e.data.total);
					break;

					// special case for Firefox, no access to IndexedDB from Web Worker :(
					case 'noIndexedDB':
						self.saveProducts(e.data.products, e.data.last);
					break;
					default:
						// ?
				}

			}, false);

			// format the last-update and send to worker
			var updated_at_min = this.formatLastUpdateFilter( Settings.get('last_update') );
			worker.postMessage({ 'cmd': 'sync', 'last_update': updated_at_min, 'wc_api_url': this.params.wc_api_url });
		},

		/**
		 * Check local product ids against a the server
		 * @return promise, then array of ids
		 */
		auditProducts: function() {
			var that = this;

			// get list of product ids from the server
			return $.getJSON( this.params.ajax_url , { 'action' : 'pos_get_product_ids' } )
			.then( function( sids ) {
				if (sids instanceof Array) {  
					// build an array of ids stored locally
					var models = that.fullCollection.models;
					var lids = [];
					for (var i = 0; i < models.length; i++) {
						lids.push(models[i].id);
					}

					// use underscore method to check difference
					var diff = _.difference(lids, sids);
					console.log(diff.length + ' products need to be deleted');
					return diff;

				} else {
					console.log('server response is no good');
				}

			}, function(jqXHR, textStatus, errorThrown) {
				console.log('error ' + textStatus);
				console.log('incoming Text ' + jqXHR.responseText);
				alert(errorThrown);
			});
		},

		/**
		 * Remove the products the local database
		 * @param  array expects and array of product ids
		 * @return null
		 */
		removeProducts: function(models) {
			if (models instanceof Array) { 

				for (var i = 0; i < models.length; i++) {
					var model = this.fullCollection.get(models[i]);
					var jqxhr = model.destroy();
					this.remove(model);
				}
				console.log(i + ' products removed');
			}
		},

		/**
		 * Fallback function for Firefox
		 */
		saveProducts: function( products, last ) {
			var self = this,
				i = 0;

			console.log('saving ' + products.length + ' products' );

			function putNext() {
				if( i < products.length ) {
					self.fullCollection.create( products[i], {
						merge: true,
						silent: true,
						success: putNext,
						error: function(model, response) {
							console.log('error saving model: ' + response.title);
						}
					});
					i++;
				}

				else {
					console.log('Saved ' + i + ' products' );
					self.fetch({ reset: true });
					if(last) {
						console.log('Sync complete!');
						Settings.set( 'last_update', Date.now() );
						$('#pagination').removeClass('working');
					}
					return;
				}
			}
			putNext();
			
		},

		/*
		 * Helper function to format the last_update timestamp to 
		 * updated_at_min as required by WC REST API
		 */
		formatLastUpdateFilter: function(timestamp) {
			var last_update = new Date( parseInt(timestamp) );

			function leadingZero(value){
				if(value < 10){
					return "0" + value.toString();
				}
				return value.toString();    
			}

			// test for valid timestamps
			if(last_update.getTime() > 0) {
				var year 	= last_update.getUTCFullYear();
		        var month 	= leadingZero( last_update.getUTCMonth() + 1 ); // starts month at 0
		        var date 	= leadingZero( last_update.getUTCDate() );
		        var hours 	= leadingZero( last_update.getUTCHours() );
		        var mins 	= leadingZero( last_update.getUTCMinutes() );
		        var secs 	= leadingZero( last_update.getUTCSeconds() );

		        return year + '-' + month + '-' + date + 'T' + hours + ':' + mins + ':' + secs + 'Z';
			} else {
				return null;
			}
		},

	});

	// You don't usually return a collection instantiated
  	return Products;

});