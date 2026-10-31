const { EventEmitter } = require('events');

const SOCKET_EVENT_MAP = {
    'order.updated': 'order_updated',
    'stock.updated': 'stock_updated',
    'order.status.updated': 'order_status_updated',
    'order.paid': 'order_paid',
    'order.cancelled': 'order_cancelled',
    'session.cancelled': 'session_cancelled',
    'bill.requested': 'bill_requested',
    'additional_items_added': 'additional_items_added',
    'table_session_closed': 'table_session_closed'
};

class EventHub extends EventEmitter {
    constructor() {
        super();
        this.io = null;
    }

    setIO(ioInstance) {
        this.io = ioInstance;
    }

    _publish(domainEvent, payload) {
        const socketEvent = SOCKET_EVENT_MAP[domainEvent] || domainEvent;
        this.emit(domainEvent, payload);
        if (this.io) {
            this.io.emit(socketEvent, payload);
        }
        return payload;
    }

    emitOrderUpdated(payload) { return this._publish('order.updated', payload); }
    emitStockUpdated(payload) { return this._publish('stock.updated', payload); }
    emitOrderStatusUpdated(payload) { return this._publish('order.status.updated', payload); }
    emitOrderPaid(payload) { return this._publish('order.paid', payload); }
    emitOrderCancelled(payload) { return this._publish('order.cancelled', payload); }
    emitSessionCancelled(payload) { return this._publish('session.cancelled', payload); }
    emitBillRequested(payload) { return this._publish('bill.requested', payload); }
    emitAdditionalItemsAdded(payload) { return this._publish('additional_items_added', payload); }
    emitTableSessionClosed(payload) { return this._publish('table_session_closed', payload); }
}

module.exports = new EventHub();
